import { Annotation, Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { acceptCompletion, closeCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { sync } from "@silverbulletmd/silverbullet/syscalls";
import type { Client } from "./client.ts";
import { customEnterCommand } from "./codemirror/markdown_enter.ts";
import { diffAndPrepareChanges } from "./codemirror/cm_util.ts";
import { decodeNote, gitBlobSha, listDrafts, writeDraft, clearDraft, newDraftId, saveNote, SaveError, type Base } from "./vault_web_save.ts";
import { t } from "./vault_web_i18n.ts";

export const inlineEditTransaction = Annotation.define<boolean>();
export type InlineEdit = { path: string; base: Base; text: string; draftId: string; saving: boolean; conflict: boolean };
const editors = new WeakMap<Client, InlineNoteEditor>();
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

export function inlineEditor(client: Client): InlineNoteEditor {
  let editor = editors.get(client);
  if (!editor) { editor = new InlineNoteEditor(client); editors.set(client, editor); }
  return editor;
}
export function isInlineEditing(client: Client, path?: string): boolean {
  const state = editors.get(client)?.state;
  return !!state && (path === undefined || state.path === path);
}
export function captureInlineChange(client: Client, text: string): boolean {
  return editors.get(client)?.change(text) ?? false;
}
export function leaveInlineEdit(client: Client, path: string): void {
  editors.get(client)?.leave(path);
}
export function inlineEditExtensions(client: Client, fallback: Extension[]): Extension {
  if (!client.bootConfig.githubRepo) return fallback;
  const editor = inlineEditor(client);
  editor.fallback = fallback;
  return editor.compartment.of(editor.extensions());
}

export class InlineNoteEditor {
  state?: InlineEdit;
  readonly compartment = new Compartment();
  fallback: Extension[] = [];
  private listeners = new Set<() => void>();
  private draftTimer?: ReturnType<typeof setTimeout>;
  private opening = 0;
  private pending = false;

  constructor(private client: Client) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }
  get dirty(): boolean { return !!this.state && this.state.text !== normalize(this.state.base.text); }

  extensions(): Extension[] {
    if (!this.state) return this.fallback;
    return [
      EditorState.readOnly.of(this.state.saving), EditorView.editable.of(!this.state.saving),
      Prec.highest(keymap.of([
        { key: "Mod-s", run: () => { void this.save(); return true; } },
        { key: "Escape", run: (view) => { if (!closeCompletion(view)) void this.close(); return true; } },
        { key: "Mod-z", run: (view) => { if (!this.state?.saving) undo(view); return true; } },
        { key: "Mod-Shift-z", run: (view) => { if (!this.state?.saving) redo(view); return true; } },
        { key: "Ctrl-y", mac: "Cmd-Shift-z", run: (view) => { if (!this.state?.saving) redo(view); return true; } },
        { key: "Enter", run: (view) => acceptCompletion(view) || customEnterCommand(view) }, ...historyKeymap, ...defaultKeymap, indentWithTab,
      ])),
    ];
  }
  private reconfigure() {
    const view = this.client.editorView;
    if (this.compartment.get(view.state) !== undefined) {
      view.dispatch({ effects: this.compartment.reconfigure(this.extensions()) });
    }
  }
  private replace(text: string) {
    const view = this.client.editorView;
    text = normalize(text);
    if (view.state.doc.toString() === text) return;
    view.dispatch({ changes: diffAndPrepareChanges(view.state.doc.toString(), text),
      annotations: inlineEditTransaction.of(true), effects: view.scrollSnapshot() });
  }

  async begin(path: string): Promise<boolean> {
    const repo = this.client.bootConfig.githubRepo;
    if (!repo || this.pending || this.client.ui.viewState?.isLoading || !path.endsWith(".md") || path.startsWith("Library/Std/")) return false;
    if (this.state) { this.client.focus(); return this.state.path === path; }
    const opening = ++this.opening;
    this.pending = true;
    try {
      const scope = { repo, path };
      const drafts = listDrafts(scope);
      let base: Base;
      try {
        const { data } = await this.client.space.spacePrimitives.readFile(path);
        const text = decodeNote(data);
        if (text === undefined) throw new Error("not-utf8");
        base = { text, sha: await gitBlobSha(data) };
      } catch (e) {
        if (!drafts.length) throw e;
        base = drafts[0]!.draft.base;
      }
      if (opening !== this.opening || this.client.currentPath() !== path) return false;
      const draft = drafts.find(({ draft }) => normalize(draft.text) !== normalize(base.text));
      this.state = { path, base: draft?.draft.base ?? base, text: normalize(draft?.draft.text ?? base.text), draftId: newDraftId(), saving: false, conflict: false };
      if (draft && this.persist()) clearDraft(scope, draft.id);
      this.replace(this.state.text);
      this.reconfigure();
      if (this.client.undoHistoryCompartment) this.client.editorView.dispatch({ effects: this.client.undoHistoryCompartment.reconfigure(history()) });
      this.emit();
      this.client.focus();
      if (draft) this.client.ui.flashNotification(t("下書きから編集を再開しました。", "Resumed your draft."));
      return true;
    } catch (e) {
      this.client.reportError(e, "begin inline editing");
      this.client.ui.flashNotification(t("このノートを編集できませんでした。", "Couldn't edit this note."), "error");
      return false;
    } finally { if (opening === this.opening) this.pending = false; }
  }

  change(text: string): boolean {
    const state = this.state;
    if (!state || this.client.currentPath() !== state.path) return false;
    state.text = text;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.persist(), 400);
    this.emit();
    return true;
  }
  persist(): boolean {
    const state = this.state;
    const repo = this.client.bootConfig.githubRepo;
    if (!state || !repo) return true;
    const scope = { repo, path: state.path };
    if (!this.dirty) { clearDraft(scope, state.draftId); return true; }
    const saved = writeDraft(scope, state.draftId, { text: state.text, base: state.base, savedAt: Date.now() });
    if (!saved) this.client.ui.flashNotification(t("下書きを保存できません。ノートを保存してから移動してください。", "Couldn't keep a draft. Save the note before leaving."), "error");
    return saved;
  }
  leave(path: string): void {
    if (this.state?.path === path) return;
    if (!this.persist()) throw new Error("Couldn't preserve the inline draft");
    ++this.opening; this.pending = false;
    this.end();
  }
  async close(): Promise<boolean> {
    const state = this.state;
    if (!state || state.saving) return false;
    if (this.dirty) {
      const confirmed = await this.client.ui.confirm(t("未保存の変更を破棄して編集を終了しますか？", "Discard unsaved changes and finish editing?"), { destructive: true });
      if (!confirmed || this.state !== state || state.saving) return false;
    }
    this.discard();
    return true;
  }
  discard(): void {
    const state = this.state;
    const repo = this.client.bootConfig.githubRepo;
    if (!state || !repo || state.saving) return;
    clearDraft({ repo, path: state.path }, state.draftId);
    this.replace(state.base.text);
    this.end();
  }
  private end() {
    clearTimeout(this.draftTimer);
    if (!this.state) return;
    this.state = undefined;
    this.reconfigure();
    this.emit();
  }

  async save(): Promise<void> {
    const state = this.state;
    const repo = this.client.bootConfig.githubRepo;
    if (!state || !repo || state.saving || !this.dirty) return;
    clearTimeout(this.draftTimer);
    this.persist();
    state.saving = true; this.reconfigure(); this.emit();
    const sentText = state.text;
    let committed = false;
    try {
      const result = await saveNote(`${document.baseURI.replace(/\/*$/, "")}/api/gh`, repo, state.path, state.base, sentText);
      committed = result.status === "saved";
      if (state.text !== sentText) { this.persist(); throw new Error("Note changed while saving"); }
      if (result.status === "conflict") {
        state.base = result.base; state.text = result.text; state.conflict = true;
        writeDraft({ repo, path: state.path }, state.draftId, { text: state.text, base: state.base, savedAt: Date.now() });
        if (this.state === state) this.replace(state.text);
        this.client.ui.flashNotification(t("最新版と衝突しました。本文の競合箇所を直して保存してください。", "Conflicting changes found. Resolve the markers in the note and save."), "error");
        return;
      }
      clearDraft({ repo, path: state.path }, state.draftId);
      // 同期の差し込みは編集中のまま止め、保存後の本文だけを受け取る。
      await sync.performSpaceSync();
      if (this.state === state && this.client.currentPath() === state.path) {
        const { data } = await this.client.space.spacePrimitives.readFile(state.path);
        if (this.state !== state || this.client.currentPath() !== state.path) return;
        if (state.text !== sentText) { this.persist(); throw new Error("Note changed while refreshing"); }
        const text = decodeNote(data);
        if (text !== undefined) this.replace(text);
        this.end();
        await this.client.contentManager.reloadPageContent();
      }
      this.client.ui.flashNotification(t("保存しました。", "Saved."));
    } catch (e) {
      this.client.reportError(e, "save inline note");
      this.client.ui.flashNotification(e instanceof SaveError && e.message === "conflict-markers"
        ? t("本文に競合の印が残っています。修正してから保存してください。", "Resolve the conflict markers before saving.")
        : e instanceof SaveError && e.message === "other-repo"
        ? t("別のタブで、開くリポジトリが切り替わりました。編集中の内容を写してから、ページを再読み込みしてください。", "Another tab opened a different repository. Copy your edits, then reload this page.")
        : committed ? t("保存しましたが、表示の更新を完了できませんでした。編集内容は残しています。", "Saved, but couldn't finish refreshing. Your edits are still here.")
        : t("保存を完了できませんでした。編集中の内容はそのまま残しています。", "Couldn't finish saving. Your edits are still here."), "error");
    } finally {
      state.saving = false;
      if (this.state === state) { this.reconfigure(); this.emit(); }
    }
  }
}
