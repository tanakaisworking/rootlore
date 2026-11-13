import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Client } from "./client.ts";
import type { CommandHook } from "./plugos/hooks/command.ts";
import type { Command } from "./types/command.ts";
import { sync } from "@silverbulletmd/silverbullet/syscalls";
import { githubApiFetch } from "./vault_web_fetch.ts";
import { openNoteEditor } from "./components/vault_web_note_editor.tsx";
import { createEmptyNote, newNotePath, registerVaultNewNoteCommand } from "./vault_web_new_note.ts";

vi.mock("@silverbulletmd/silverbullet/syscalls", () => ({ sync: { performSpaceSync: vi.fn() } }));
vi.mock("./vault_web_fetch.ts", () => ({ githubApiFetch: vi.fn() }));
vi.mock("./components/vault_web_note_editor.tsx", () => ({ openNoteEditor: vi.fn() }));
vi.mock("./vault_web_i18n.ts", () => ({ t: (ja: string) => ja }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", { baseURI: "https://app.example/", querySelector: () => null });
  vi.mocked(sync.performSpaceSync).mockResolvedValue(1);
});
afterEach(() => vi.unstubAllGlobals());

test("new note paths keep folders, add .md, and reject reserved and invalid paths", () => {
  expect(newNotePath(" Folder/ノート ")).toBe("Folder/ノート.md");
  expect(newNotePath("a.MD")).toBe("a.md");
  for (const path of ["", ".hidden", "../x", "/x", "x/", "x//y", "x\\y", "Library/Std/x", "x\u0000y"]) expect(newNotePath(path)).toBeUndefined();
});

function setup(name: string | undefined) {
  let command: Command;
  const client = {
    bootConfig: { githubRepo: {} },
    ui: { prompt: vi.fn(async () => name), flashNotification: vi.fn() },
    navigate: vi.fn(async () => {}), reportError: vi.fn(),
  } as unknown as Client;
  registerVaultNewNoteCommand(client, { registerCommand: (c: Command) => { command = c; } } as CommandHook);
  return { client, run: () => command.run!() };
}

test("new note creation uses null as the precondition and opens the editor after confirmed sync", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ files: [{ path: "Folder/new.md", sha: "a".repeat(40) }] }));
  const { client, run } = setup("Folder/new");
  await run();
  const body = JSON.parse(vi.mocked(githubApiFetch).mock.calls[0][2]!.body as string);
  expect(body).toEqual({ files: [{ path: "Folder/new.md", content: "", baseSha: null }] });
  expect(sync.performSpaceSync).toHaveBeenCalledOnce();
  expect(client.navigate).toHaveBeenCalledWith({ path: "Folder/new.md" });
  expect(openNoteEditor).toHaveBeenCalledExactlyOnceWith("Folder/new.md");
});

test("a name collision never retries, merges or opens the existing note", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ conflicts: [] }, { status: 409 }));
  const { client, run } = setup("existing");
  await run();
  expect(githubApiFetch).toHaveBeenCalledOnce();
  expect(client.navigate).not.toHaveBeenCalled(); expect(openNoteEditor).not.toHaveBeenCalled();
  expect(client.ui.flashNotification).toHaveBeenCalledWith("同じ名前のノートがあります。別の名前で作成してください。", "error");
});

test("cancel and invalid names don't create a file", async () => {
  await setup(undefined).run(); await setup("../escape").run();
  expect(githubApiFetch).not.toHaveBeenCalled();
});

test("an unexpected successful response doesn't claim that a file exists", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({}));
  await expect(createEmptyNote("/api/gh", "new.md")).rejects.toThrow("no-file");
});
