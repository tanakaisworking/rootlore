import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { Compartment, EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history } from "@codemirror/commands";
import type { Client } from "./client.ts";
import { h } from "preact";
import { render } from "preact-render-to-string";
import { VaultWebNoteEditor } from "./components/vault_web_note_editor.tsx";
import { sync } from "@silverbulletmd/silverbullet/syscalls";
import { createEditorUpdateHandler } from "./codemirror/editor_state.ts";
import { ContentManager } from "./content_manager.ts";
import { gitBlobSha, saveNote, listDrafts } from "./vault_web_save.ts";
import { inlineEditor, inlineEditExtensions, inlineEditTransaction, leaveInlineEdit, isInlineEditing } from "./vault_web_inline_edit.ts";

vi.hoisted(() => {
  vi.stubGlobal("document", { documentElement: { style: { removeProperty() {}, setProperty() {} }, dataset: {} }, addEventListener() {} });
  vi.stubGlobal("navigator", { platform: "Linux", userAgent: "", vendor: "" });
});
vi.mock("./components/widget_sandbox_iframe.ts", () => ({
  prepareSandboxIFrame() { throw new Error("Unexpected iframe"); },
  getSandboxIFrame() { throw new Error("Unexpected iframe"); },
}));
vi.mock("@silverbulletmd/silverbullet/syscalls", async (original) => ({ ...await original<typeof import("@silverbulletmd/silverbullet/syscalls")>(), sync: { performSpaceSync: vi.fn() } }));
vi.mock("./vault_web_i18n.ts", () => ({ t: (ja: string) => ja }));
vi.mock("./vault_web_save.ts", async (original) => ({ ...await original<typeof import("./vault_web_save.ts")>(), saveNote: vi.fn() }));

const repo = { owner: "me", repo: "notes", branch: "main" };
const path = "notes/test.md";
let store: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); },
    key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; },
  });
  vi.stubGlobal("document", { baseURI: "https://app.example/" });
  vi.mocked(sync.performSpaceSync).mockResolvedValue(1);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  let currentPath = path; let remote = "# Original\n\nBody";
  const readFile = vi.fn(async () => ({ data: new TextEncoder().encode(remote), meta: { lastModified: 1000 } }));
  const client = {
    bootConfig: { githubRepo: repo, readOnly: true },
    currentPath: () => currentPath, focus: vi.fn(), reportError: vi.fn(), save: vi.fn(async () => {}), dispatchAppEvent: vi.fn(),
    ui: { viewState: { isLoading: false }, viewDispatch: vi.fn(), flashNotification: vi.fn(), confirm: vi.fn(async () => true) },
    contentManager: { debouncedUpdateEvent: vi.fn(), reloadPageContent: vi.fn(async () => {}) },
    space: { spacePrimitives: { readFile }, readPage: vi.fn() }, undoHistoryCompartment: new Compartment(),
  } as unknown as Client;
  let state = EditorState.create({ doc: remote, extensions: [
    inlineEditExtensions(client, [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
    client.undoHistoryCompartment!.of(history()),
  ] });
  const listener = createEditorUpdateHandler(client, { kind: "page", pageName: "notes/test" });
  const view = {
    get state() { return state; }, composing: false,
    scrollSnapshot: () => StateEffect.define<null>().of(null),
    dispatch: (spec: TransactionSpec) => {
      const tr = state.update(spec); state = tr.state;
      listener({ state, transactions: [tr], docChanged: tr.docChanged, view, changes: tr.changes } as any);
    },
  } as unknown as EditorView;
  client.editorView = view;
  const edit = (text: string) => view.dispatch({ changes: { from: 0, to: state.doc.length, insert: text } });
  const switchPath = (next: string, text: string) => {
    currentPath = next;
    state = EditorState.create({ doc: text, extensions: [EditorState.readOnly.of(true)] });
  };
  return { client, view, editor: inlineEditor(client), edit, readFile, switchPath, remote: (text: string) => { remote = text; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("the same editor becomes writable and all changes go to drafts, never the legacy autosave", async () => {
  const s = setup(); const view = s.view;
  expect(view.state.readOnly).toBe(true);
  await s.editor.begin(path);
  expect(s.client.editorView).toBe(view); expect(view.state.readOnly).toBe(false);
  s.edit("# Edited\n\nSame view");
  expect(s.editor.dirty).toBe(true); expect(s.editor.state?.text).toBe("# Edited\n\nSame view");
  expect(s.client.save).not.toHaveBeenCalled(); expect(saveNote).not.toHaveBeenCalled();
  expect(s.editor.persist()).toBe(true);
  expect(listDrafts({ repo, path })[0]?.draft.text).toBe("# Edited\n\nSame view");
  await s.editor.close(); expect(view.state.readOnly).toBe(true);
  expect(view.state.doc.toString()).toBe("# Original\n\nBody");
  expect(listDrafts({ repo, path })).toEqual([]);
  await s.editor.begin(path); expect(view.state.doc.toString()).toBe("# Original\n\nBody");
});

test("leaving a note preserves its draft and storage failure blocks leaving", async () => {
  const s = setup(); await s.editor.begin(path); s.edit("unsaved");
  leaveInlineEdit(s.client, "other.md");
  expect(isInlineEditing(s.client)).toBe(false);
  expect(listDrafts({ repo, path })[0]?.draft.text).toBe("unsaved");
  await s.editor.begin(path);
  vi.stubGlobal("localStorage", { setItem() { throw new Error("full"); } });
  expect(() => leaveInlineEdit(s.client, "other.md")).toThrow("preserve");
  vi.mocked(s.client.ui.confirm).mockResolvedValue(false);
  expect(await s.editor.close()).toBe(false); expect(isInlineEditing(s.client)).toBe(true);
});

test("save freezes typing, uses the original blob SHA and returns the same view to read-only", async () => {
  const s = setup(); await s.editor.begin(path); s.edit("saved text");
  const pending = deferred<any>(); vi.mocked(saveNote).mockReturnValue(pending.promise);
  const saving = s.editor.save(); expect(s.view.state.readOnly).toBe(true);
  expect(saveNote).toHaveBeenCalledWith("https://app.example/api/gh", repo, path,
    { text: "# Original\n\nBody", sha: await gitBlobSha(new TextEncoder().encode("# Original\n\nBody")) }, "saved text");
  s.remote("saved text"); pending.resolve({ status: "saved", sha: "a".repeat(40), merged: false }); await saving;
  expect(s.editor.state).toBeUndefined(); expect(s.view.state.readOnly).toBe(true);
  expect(s.view.state.doc.toString()).toBe("saved text"); expect(listDrafts({ repo, path })).toEqual([]);
  expect(s.client.contentManager.reloadPageContent).toHaveBeenCalledOnce();
});

test("conflicts stay in the live editor and retain the updated base for resolution", async () => {
  const s = setup(); await s.editor.begin(path); s.edit("ours");
  const base = { text: "theirs", sha: "b".repeat(40) };
  vi.mocked(saveNote).mockResolvedValue({ status: "conflict", base, text: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs" });
  await s.editor.save(); expect(s.editor.state?.base).toEqual(base);
  expect(s.view.state.readOnly).toBe(false); expect(s.view.state.doc.toString()).toContain("<<<<<<<");
  expect(listDrafts({ repo, path })[0]?.draft.base).toEqual(base);
});

test("late save results never overwrite a different note, including the final refresh read", async () => {
  const s = setup(); await s.editor.begin(path); s.edit("ours");
  vi.mocked(saveNote).mockResolvedValue({ status: "saved", sha: "a".repeat(40), merged: false });
  const refreshed = deferred<any>();
  s.readFile.mockReturnValueOnce(refreshed.promise);
  const saving = s.editor.save();
  await vi.waitFor(() => expect(s.readFile).toHaveBeenCalledTimes(2));
  leaveInlineEdit(s.client, "other.md"); s.switchPath("other.md", "other note");
  refreshed.resolve({ data: new TextEncoder().encode("ours"), meta: { lastModified: 2000 } }); await saving;
  expect(s.view.state.doc.toString()).toBe("other note");
});

test("a pending edit open is cancelled by navigation", async () => {
  const s = setup(); const pending = deferred<any>(); s.readFile.mockReturnValueOnce(pending.promise);
  const opening = s.editor.begin(path);
  leaveInlineEdit(s.client, "other.md"); s.switchPath("other.md", "other note");
  pending.resolve({ data: new TextEncoder().encode("old note"), meta: { lastModified: 1000 } });
  expect(await opening).toBe(false); expect(s.view.state.doc.toString()).toBe("other note");
});

test("reload cannot overwrite an active inline draft and undo never falls through to file moves", async () => {
  const s = setup(); await s.editor.begin(path); s.edit("local draft");
  await ContentManager.prototype.reloadPageContent.call({ client: s.client } as any);
  await ContentManager.prototype.loadPage.call({ client: s.client } as any, { path: path as any });
  expect(s.client.space.readPage).not.toHaveBeenCalled();
  const bindings = s.view.state.facet(keymap).flat();
  expect(bindings.find((binding) => binding.key === "Mod-z")!.run!(s.view)).toBe(true);
  s.editor.discard(); expect(s.editor.state).toBeUndefined(); expect(s.view.state.readOnly).toBe(true);
  expect(listDrafts({ repo, path })).toEqual([]);
});


test("editing controls stay in the header and never create a second editor or dialog", async () => {
  const s = setup(); await s.editor.begin(path); s.edit("edited");
  const html = render(h(VaultWebNoteEditor, { client: s.client }));
  expect(html).toContain('class="vw-inline-editor-controls"');
  expect(html).toContain('data-rootlore-action="save"');
  expect(html).toContain('data-rootlore-action="close"');
  expect(html).not.toContain("textarea"); expect(html).not.toContain('role="dialog"');
});


test("Done cancels safely or discards the persisted draft, while unchanged notes close without asking", async () => {
  const s = setup(); await s.editor.begin(path);
  expect(await s.editor.close()).toBe(true);
  expect(s.client.ui.confirm).not.toHaveBeenCalled();
  await s.editor.begin(path); s.edit("unsaved"); s.editor.persist();
  vi.mocked(s.client.ui.confirm).mockResolvedValue(false);
  expect(await s.editor.close()).toBe(false);
  expect(s.view.state.doc.toString()).toBe("unsaved");
  expect(s.view.state.readOnly).toBe(false);
  vi.mocked(s.client.ui.confirm).mockResolvedValue(true);
  expect(await s.editor.close()).toBe(true);
  expect(listDrafts({ repo, path })).toEqual([]);
  expect(s.view.state.doc.toString()).toBe("# Original\n\nBody");
  expect(s.view.state.readOnly).toBe(true);
});
