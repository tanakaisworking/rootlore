import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Client } from "./client.ts";
import { inlineEditor } from "./vault_web_inline_edit.ts";
import { sync } from "@silverbulletmd/silverbullet/syscalls";
import { githubApiFetch } from "./vault_web_fetch.ts";
import { gitBlobSha, hasDraftsUnder, listDrafts } from "./vault_web_save.ts";
import { moveVaultFile, moveVaultFolder, renamedFolder, renamedPath, undoVaultMove, redoVaultMove } from "./vault_web_move.ts";

vi.mock("@silverbulletmd/silverbullet/syscalls", () => ({ sync: { performSpaceSync: vi.fn() } }));
vi.mock("./vault_web_fetch.ts", () => ({ githubApiFetch: vi.fn() }));
vi.mock("./vault_web_i18n.ts", () => ({ t: (ja: string) => ja }));

test("renaming keeps the folder and the extension, and refuses names that would move the file", () => {
  expect(renamedPath("Projects/rootlore/無題のノート.md", "計画")).toBe("Projects/rootlore/計画.md");
  expect(renamedPath("Projects/rootlore/無題のノート.md", " 計画.md ")).toBe("Projects/rootlore/計画.md");
  expect(renamedPath("top.md", "新しい名前")).toBe("新しい名前.md");
  expect(renamedPath("Notes/table.base", "一覧")).toBe("Notes/一覧.base");
  for (const name of ["", "  ", ".hidden", "a/b", "a\\b", "無題のノート"]) {
    expect(renamedPath("Projects/rootlore/無題のノート.md", name)).toBeUndefined();
  }
});
vi.mock("./vault_web_save.ts", async (original) => ({
  ...await original<typeof import("./vault_web_save.ts")>(), listDrafts: vi.fn(() => []), hasDraftsUnder: vi.fn(() => false),
}));

const data = new Uint8Array([0, 255, 128, 42]);
const source = "image.png";
const destination = "folder/image.png";
const notify = vi.fn();
const navigate = vi.fn();
const readFile = vi.fn();
const baseClient = {
  bootConfig: { githubRepo: { owner: "me", repo: "notes", branch: "main" } },
  space: { spacePrimitives: { readFile } },
  ui: { flashNotification: notify },
  currentPath: () => source,
  navigate,
  reportError: vi.fn(),
} as unknown as Client;
let client = baseClient;

beforeEach(() => {
  vi.clearAllMocks();
  client = Object.create(baseClient) as Client;
  vi.stubGlobal("document", { baseURI: "https://app.example/" });
  readFile.mockResolvedValue({ data, meta: { lastModified: 1000 } });
  vi.mocked(sync.performSpaceSync).mockResolvedValue(1);
  vi.mocked(listDrafts).mockReturnValue([]);
  vi.mocked(hasDraftsUnder).mockReturnValue(false);
});
afterEach(() => vi.unstubAllGlobals());

test("renaming a folder keeps its parent and refuses names that would move it elsewhere", () => {
  expect(renamedFolder("Projects/old", "new")).toBe("Projects/new");
  expect(renamedFolder("top", " 上 ")).toBe("上");
  for (const name of ["", ".hidden", "a/b", "old"]) expect(renamedFolder("Projects/old", name)).toBeUndefined();
});

test("a folder move sends the whole folder, follows the open note inside it, and undoes as a folder", async () => {
  const folderClient = Object.create(client, { currentPath: { value: () => "Projects/old/sub/a.md" } }) as Client;
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  expect(await moveVaultFolder(folderClient, "Projects/old", "Archive/old")).toBe(true);
  expect(JSON.parse(vi.mocked(githubApiFetch).mock.calls[0][2]!.body as string)).toEqual({ source: "Projects/old", destination: "Archive/old", folder: true });
  expect(readFile).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith({ path: "Archive/old/sub/a.md" });
  expect(await undoVaultMove(folderClient)).toBe(true);
  expect(JSON.parse(vi.mocked(githubApiFetch).mock.calls[1][2]!.body as string)).toEqual({ source: "Archive/old", destination: "Projects/old", folder: true });
});

test("a draft anywhere in the folder, or a refused move, leaves the folder where it is", async () => {
  vi.mocked(hasDraftsUnder).mockImplementation((_repo, folder) => folder === "Projects/old");
  expect(await moveVaultFolder(client, "Projects/old", "Archive/old")).toBe(false);
  expect(githubApiFetch).not.toHaveBeenCalled();
  vi.mocked(hasDraftsUnder).mockReturnValue(false);
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));
  expect(await moveVaultFolder(client, "Projects/old", "Archive/old")).toBe(false);
  expect(sync.performSpaceSync).not.toHaveBeenCalled();
  expect(await undoVaultMove(client)).toBe(false);
});

test("a confirmed binary move syncs and follows the open file only after the server accepts it", async () => {
  vi.mocked(githubApiFetch).mockImplementation(async (_base, _path, init) => {
    expect(navigate).not.toHaveBeenCalled();
    expect(sync.performSpaceSync).not.toHaveBeenCalled();
    expect(JSON.parse(init!.body as string)).toEqual({ source, destination, baseSha: await gitBlobSha(data) });
    return Response.json({ moved: true });
  });
  expect(await moveVaultFile(client, source, destination, 1000)).toBe(true);
  expect(githubApiFetch).toHaveBeenCalledWith("https://app.example/api/gh", "/move", expect.anything(), { redirectToLogin: false });
  expect(sync.performSpaceSync).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith({ path: destination });
});

test("a server conflict leaves the source and navigation unchanged and shows the requested message", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));
  expect(await moveVaultFile(client, source, destination, 1000)).toBe(false);
  expect(sync.performSpaceSync).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(notify).toHaveBeenLastCalledWith("最新版と衝突するため移動を一時停止しました", "error");
});

test("a source refreshed since it was displayed is not moved", async () => {
  expect(await moveVaultFile(client, source, destination, 999)).toBe(false);
  expect(githubApiFetch).not.toHaveBeenCalled();
  expect(notify).toHaveBeenLastCalledWith("最新版と衝突するため移動を一時停止しました", "error");
});

test("unsaved drafts prevent a move from orphaning an edit", async () => {
  vi.mocked(listDrafts).mockReturnValue([{ id: "draft", draft: { text: "unsaved", base: { text: "", sha: null }, savedAt: 1 } }]);
  expect(await moveVaultFile(client, source, destination)).toBe(false);
  expect(githubApiFetch).not.toHaveBeenCalled();
});

test("a failed refresh after a successful commit reports that the file was already moved", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  vi.mocked(sync.performSpaceSync).mockRejectedValue(new Error("offline"));
  expect(await moveVaultFile(client, source, destination)).toBe(false);
  expect(notify).toHaveBeenLastCalledWith("移動しましたが、表示を更新できませんでした。再読み込みしてください。", "error");
});

test("successive moves undo in reverse order and can be redone", async () => {
  vi.mocked(githubApiFetch).mockImplementation(async () => Response.json({ moved: true }));
  await moveVaultFile(client, source, destination);
  await moveVaultFile(client, destination, "archive/image.png");
  expect(await undoVaultMove(client)).toBe(true);
  expect(await undoVaultMove(client)).toBe(true);
  expect(await undoVaultMove(client)).toBe(false);
  expect(await redoVaultMove(client)).toBe(true);
  const paths = vi.mocked(githubApiFetch).mock.calls.map((call) => {
    const { source, destination } = JSON.parse(call[2]!.body as string);
    return [source, destination];
  });
  expect(paths).toEqual([
    [source, destination], [destination, "archive/image.png"],
    ["archive/image.png", destination], [destination, source], [source, destination],
  ]);
});

test("a conflicted undo retains history for a retry", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  await moveVaultFile(client, source, destination);
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));
  expect(await undoVaultMove(client)).toBe(false);
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  expect(await undoVaultMove(client)).toBe(true);
  expect(await undoVaultMove(client)).toBe(false);
});

test("undo refuses to move content edited since the original move", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  await moveVaultFile(client, source, destination);
  readFile.mockResolvedValue({ data: new TextEncoder().encode("edited"), meta: { lastModified: 2000 } });
  expect(await undoVaultMove(client)).toBe(false);
  expect(githubApiFetch).toHaveBeenCalledOnce();
  readFile.mockResolvedValue({ data, meta: { lastModified: 3000 } });
  expect(await undoVaultMove(client)).toBe(true);
});

test("only a successful new move clears redo history", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  await moveVaultFile(client, source, destination);
  await undoVaultMove(client);
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));
  await moveVaultFile(client, "other.png", "folder/other.png");
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  expect(await redoVaultMove(client)).toBe(true);
  await undoVaultMove(client);
  await moveVaultFile(client, "other.png", "folder/other.png");
  expect(await redoVaultMove(client)).toBe(false);
});

test("a committed move is undoable even when refreshing its view failed", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  vi.mocked(sync.performSpaceSync).mockRejectedValue(new Error("offline"));
  await moveVaultFile(client, source, destination);
  vi.mocked(sync.performSpaceSync).mockResolvedValue(1);
  expect(await undoVaultMove(client)).toBe(true);
});

test("a fresh client does not inherit another session's undo history", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ moved: true }));
  await moveVaultFile(client, source, destination);
  expect(await undoVaultMove(Object.create(baseClient) as Client)).toBe(false);
});


test("an active inline edit blocks moving the note before the draft debounce fires", async () => {
  inlineEditor(client).state = { path: "note.md", base: { text: "", sha: null }, text: "typed", draftId: "draft", saving: false, conflict: false };
  expect(await moveVaultFile(client, "note.md", "folder/note.md")).toBe(false);
  expect(readFile).not.toHaveBeenCalled(); expect(githubApiFetch).not.toHaveBeenCalled();
});
