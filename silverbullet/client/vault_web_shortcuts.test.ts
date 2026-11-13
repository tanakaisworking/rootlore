import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "./client.ts";
import { installVaultShortcuts, shortcutKeys, vaultShortcutCommand, vaultShortcuts } from "./vault_web_shortcuts.ts";

vi.mock("../plug-api/lib/shortcut.ts", () => ({ isMacLike: true }));
afterEach(() => vi.unstubAllGlobals());

const keyEvent = (key: string, options = {}) => ({
  key, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...options,
});

test.each([
  ["n", false, "Vault: New note"],
  [",", false, "Vault: Settings"], ["k", false, "Navigate: Page Picker"],
  ["p", false, "Navigate: Page Picker"], ["e", false, "Vault: Edit note"],
  ["z", false, "Vault: Undo move"], ["Z", true, "Vault: Redo move"],
])("macOS and Windows primary shortcuts: %s", (key, shiftKey, command) => {
  expect(vaultShortcutCommand(keyEvent(key, { shiftKey }), true)).toBe(command);
  expect(vaultShortcutCommand(keyEvent(key, { shiftKey, metaKey: false, ctrlKey: true }), false)).toBe(command);
});

test("undo and redo in text fields stay native; unrelated modifiers and IME composition are ignored", () => {
  for (const key of ["z", "y"]) expect(vaultShortcutCommand(keyEvent(key), true, true)).toBeUndefined();
  expect(vaultShortcutCommand(keyEvent("y", { metaKey: false, ctrlKey: true }), false)).toBe("Vault: Redo move");
  for (const options of [{ altKey: true }, { isComposing: true }, { metaKey: false }, { ctrlKey: true }, { shiftKey: true }]) {
    expect(vaultShortcutCommand(keyEvent(",", options), true)).toBeUndefined();
  }
  expect(shortcutKeys("Vault: Settings").mac).toBe("Cmd-,");
});

function setup({ field = false, content = false, dialog = false, ready = true, editable = false } = {}) {
  const add = vi.fn(); const remove = vi.fn(); const run = vi.fn(async () => {});
  vi.stubGlobal("addEventListener", add); vi.stubGlobal("removeEventListener", remove);
  const client = {
    bootConfig: { githubRepo: {} }, isReadOnlyMode: () => true, editorView: { state: { readOnly: !editable } },
    ui: { viewState: { commands: new Map(ready ? vaultShortcuts.map((s) => [s.command, {}]) : []) } },
    runCommandByName: run, reportError: vi.fn(),
  } as unknown as Client;
  const dispose = installVaultShortcuts(client);
  const handle = add.mock.calls[0][1];
  const event = (key: string, extras = {}) => ({
    ...keyEvent(key), defaultPrevented: false, repeat: false,
    target: { closest: (selector: string) => selector.includes(".vw-note-editor")
      ? (dialog ? {} : null) : (field || content ? { matches: () => content } : null) },
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extras,
  });
  return { handle, event, run, dispose, remove };
}

test("capture claims the shortcut once and suppresses the browser/legacy binding", () => {
  const { handle, event, run, dispose, remove } = setup();
  const e = event("p"); handle(e);
  expect(run).toHaveBeenCalledExactlyOnceWith("Navigate: Page Picker");
  expect(e.preventDefault).toHaveBeenCalledOnce(); expect(e.stopPropagation).toHaveBeenCalledOnce();
  handle(event("p", { repeat: true })); expect(run).toHaveBeenCalledOnce();
  dispose(); expect(remove).toHaveBeenCalledWith("keydown", handle, { capture: true });
});

test("text inputs keep native undo while a read-only note can undo file moves", () => {
  const field = setup({ field: true }); const nativeUndo = field.event("z"); field.handle(nativeUndo);
  expect(field.run).not.toHaveBeenCalled(); expect(nativeUndo.preventDefault).not.toHaveBeenCalled();
  const content = setup({ content: true }); content.handle(content.event("z"));
  expect(content.run).toHaveBeenCalledExactlyOnceWith("Vault: Undo move");
});

test("the note edit dialog and not-yet-available commands keep their own key behavior", () => {
  for (const options of [{ dialog: true }, { ready: false }]) {
    const s = setup(options); const e = s.event(","); s.handle(e);
    expect(s.run).not.toHaveBeenCalled(); expect(e.preventDefault).not.toHaveBeenCalled();
  }
});


test("a writable inline CodeMirror retains text undo even though the Vault is otherwise read-only", () => {
  const s = setup({ content: true, editable: true }); const e = s.event("z"); s.handle(e);
  expect(s.run).not.toHaveBeenCalled(); expect(e.preventDefault).not.toHaveBeenCalled();
});
