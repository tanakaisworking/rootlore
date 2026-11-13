import type { Client } from "./client.ts";
import { language, t } from "./vault_web_i18n.ts";

declare global {
  var rootloreMenuAction: ((action: string) => void) | undefined;
}

const commands: Record<string, string> = {
  new: "Vault: New note", open: "Navigate: Page Picker", edit: "Vault: Edit note",
  settings: "Vault: Settings", shortcuts: "Vault: Settings", home: "Navigate: Home",
  sync: "Sync: Space", undo_move: "Vault: Undo move", redo_move: "Vault: Redo move",
};

export function desktopMenuAction(client: Client, action: string): void {
  if (action === "save") {
    document.querySelector<HTMLButtonElement>('#sb-top .vw-inline-editor-controls [data-rootlore-action="save"]')?.click();
    return;
  }
  if (action === "reload") { location.reload(); return; }
  const command = Object.hasOwn(commands, action) ? commands[action] : undefined;
  if (!command) return;
  if (document.querySelector("#sb-top .vw-inline-editor-controls")) {
    client.ui.flashNotification(t("編集中のノートを閉じてから操作してください。", "Close the note editor before using this action."), "error");
    return;
  }
  void client.runCommandByName(command).catch((e) => client.reportError(e, "desktop menu"));
}

export function installDesktopMenu(client: Client): () => void {
  const native = (globalThis as any).__TAURI_INTERNALS__;
  if (!native?.invoke) return () => {};
  globalThis.rootloreMenuAction = (action) => desktopMenuAction(client, action);
  let previous = "";
  const update = () => {
    const canSave = !!document.querySelector<HTMLButtonElement>('#sb-top .vw-inline-editor-controls [data-rootlore-action="save"]:not(:disabled)');
    const locale = document.documentElement.lang === "ja" ? "ja" : document.documentElement.lang === "en" ? "en" : language;
    const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue("--panel-background-color").trim();
    const state = `${locale}:${canSave}:${backgroundColor}`;
    if (state === previous) return;
    previous = state;
    void native.invoke("set_menu_state", { language: locale, canSave, backgroundColor }).catch((e: unknown) => {
      previous = "";
      console.warn("Rootlore: couldn't update native menu", e);
    });
  };
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["lang", "disabled", "data-theme"] });
  const scheme = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  scheme?.addEventListener("change", update);
  update();
  return () => { observer.disconnect(); scheme?.removeEventListener("change", update); globalThis.rootloreMenuAction = undefined; };
}
