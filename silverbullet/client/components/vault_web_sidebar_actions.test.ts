import { expect, test, vi } from "vitest";
import type { Client } from "../client.ts";
import { sidebarActions } from "./vault_web_sidebar_actions.tsx";
import { resolveButtonIcon } from "../lib/feather_icons.ts";

function fakeClient(buttons: unknown[]) {
  const runCommandByName = vi.fn();
  const client = {
    ui: {
      viewState: { isMobile: false, isStandalone: false, commands: new Map() },
    },
    config: { get: () => buttons },
    bootConfig: {},
    runCommandByName,
  } as unknown as Client;
  return { client, runCommandByName };
}

test("並びは priority の高い順（ホーム、更新、検索）。編集（上部のバー）、アカウント、コマンドパレット、PWA 専用のボタンは出さない", () => {
  const { client } = fakeClient([
    { icon: "home", description: "Go to the index page", command: "Navigate: Home", priority: 3 },
    { icon: "book", description: "Open page", command: "Navigate: Page Picker", priority: 2 },
    { icon: "refresh-cw", description: "最新の状態に更新", command: "Sync: Space", priority: 2.5 },
    { icon: "edit-3", description: "編集", command: "Vault: Edit note", priority: 4.5 },
    { icon: "profile", description: "Account", priority: 9 },
    { icon: "terminal", description: "Run command", command: "Open Command Palette", priority: 1 },
    { icon: "chevron-left", description: "Go back", standalone: true, priority: 0 },
  ]);
  expect(sidebarActions(client).map((a) => a.title)).toEqual([
    "ホーム",
    "最新の状態に更新",
    "ノートを検索",
  ]);
});

test("ノートを検索の絵は本ではなく虫眼鏡にする", () => {
  const { client } = fakeClient([
    { icon: "book", description: "Open page", command: "Navigate: Page Picker" },
  ]);
  const [action] = sidebarActions(client);
  expect(action.title).toBe("ノートを検索");
  expect(action.icon).toBe(resolveButtonIcon("search"));
  expect(action.icon).not.toBe(resolveButtonIcon("book"));
});

test("押すとそのコマンドを実行する", () => {
  const { client, runCommandByName } = fakeClient([
    { icon: "refresh-cw", description: "GitHub の最新を読み込む", command: "Sync: Space" },
  ]);
  sidebarActions(client)[0].run();
  expect(runCommandByName).toHaveBeenCalledWith("Sync: Space");
});
