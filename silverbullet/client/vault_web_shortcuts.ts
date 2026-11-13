import type { Client } from "./client.ts";
import { isInlineEditing } from "./vault_web_inline_edit.ts";
import { isMacLike } from "../plug-api/lib/shortcut.ts";

export const vaultShortcuts = [
  { command: "Vault: New note", key: "Ctrl-n", mac: "Cmd-n", ja: "ノートを新規作成", en: "New note" },
  { command: "Vault: Settings", key: "Ctrl-,", mac: "Cmd-,", ja: "設定", en: "Settings" },
  { command: "Navigate: Page Picker", key: ["Ctrl-k", "Ctrl-p"], mac: ["Cmd-k", "Cmd-p"], ja: "ノートを検索", en: "Search notes" },
  { command: "Vault: Edit note", key: "Ctrl-e", mac: "Cmd-e", ja: "ノートを編集", en: "Edit note" },
  { command: "Vault: Undo move", key: "Ctrl-z", mac: "Cmd-z", ja: "ファイル移動を取り消す", en: "Undo file move" },
  { command: "Vault: Redo move", key: ["Ctrl-Shift-z", "Ctrl-y"], mac: "Cmd-Shift-z", ja: "ファイル移動をやり直す", en: "Redo file move" },
];

export function shortcutKeys(command: string) {
  const shortcut = vaultShortcuts.find((s) => s.command === command);
  return shortcut ? { key: shortcut.key, mac: shortcut.mac } : {};
}

type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">;
export function vaultShortcutCommand(event: KeyEvent, mac: boolean, nativeEditing = false): string | undefined {
  if (event.isComposing || event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (nativeEditing && ["z", "y"].includes(key)) return;
  const chord = `${mac ? "Cmd" : "Ctrl"}-${event.shiftKey ? "Shift-" : ""}${key}`.toLowerCase();
  return vaultShortcuts.find((s) => [mac ? s.mac : s.key].flat().some((binding) => binding.toLowerCase() === chord))?.command;
}

/** Safari/Tauriでもブラウザ側の印刷や旧ライブラリの割り当てより先に処理する。 */
export function installVaultShortcuts(client: Client): () => void {
  if (!client.bootConfig.githubRepo) return () => {};
  const handler = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (target?.closest?.(".vw-note-editor, .sb-anchored-menu")) return;
    if (isInlineEditing(client) && ["z", "y"].includes(event.key.toLowerCase())) return;
    const field = target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    const nativeEditing = !!field && !(field.matches(".cm-content") && (client.editorView?.state.readOnly ?? client.isReadOnlyMode()));
    const command = vaultShortcutCommand(event, isMacLike, nativeEditing);
    if (!command || !client.ui.viewState.commands.has(command)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void client.runCommandByName(command).catch((e) => client.reportError(e, "keyboard shortcut"));
  };
  globalThis.addEventListener("keydown", handler, { capture: true });
  return () => globalThis.removeEventListener("keydown", handler, { capture: true });
}
