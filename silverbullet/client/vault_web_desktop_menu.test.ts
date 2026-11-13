import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "./client.ts";
import { desktopMenuAction, installDesktopMenu } from "./vault_web_desktop_menu.ts";

afterEach(() => vi.unstubAllGlobals());

test("native actions route to existing commands and ignore arbitrary command names", () => {
  const run = vi.fn(async () => {});
  vi.stubGlobal("document", { querySelector: () => null });
  const client = { runCommandByName: run } as unknown as Client;
  desktopMenuAction(client, "new"); desktopMenuAction(client, "settings"); desktopMenuAction(client, "undo_move");
  desktopMenuAction(client, "constructor"); desktopMenuAction(client, "Delete everything");
  expect(run.mock.calls).toEqual([["Vault: New note"], ["Vault: Settings"], ["Vault: Undo move"]]);
});

test("Save clicks the editor's existing save control; other actions preserve an open edit", () => {
  const save = vi.fn(); const run = vi.fn(); const notify = vi.fn();
  vi.stubGlobal("document", { querySelector: (selector: string) => selector.includes("data-rootlore") ? { click: save } : {} });
  const client = { runCommandByName: run, ui: { flashNotification: notify } } as unknown as Client;
  desktopMenuAction(client, "save"); desktopMenuAction(client, "new");
  expect(save).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledOnce();
});

test("menu state follows UI language and save availability, without repeatedly sending identical state", async () => {
  const invoke = vi.fn(async () => {}); let changed: () => void = () => {}; const disconnect = vi.fn();
  let canSave = false; const root = { lang: "ja" };
  let color = "#262626";
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => color }));
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  vi.stubGlobal("document", { documentElement: root, querySelector: () => canSave ? {} : null });
  vi.stubGlobal("MutationObserver", class { constructor(callback: () => void) { changed = callback; } observe() {} disconnect = disconnect; });
  const dispose = installDesktopMenu({} as Client);
  expect(invoke).toHaveBeenLastCalledWith("set_menu_state", { language: "ja", canSave: false, backgroundColor: "#262626" });
  changed(); expect(invoke).toHaveBeenCalledOnce();
  root.lang = "en"; canSave = true; color = "#f6f6f6"; changed();
  expect(invoke).toHaveBeenLastCalledWith("set_menu_state", { language: "en", canSave: true, backgroundColor: "#f6f6f6" });
  dispose(); expect(disconnect).toHaveBeenCalledOnce(); expect(globalThis.rootloreMenuAction).toBeUndefined();
});
