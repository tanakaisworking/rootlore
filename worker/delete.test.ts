import { afterEach, expect, test, vi } from "vitest";
import { deleteFile, handleDelete, parseDeleteRequest } from "./delete";

afterEach(() => vi.unstubAllGlobals());
const sha = (n: number) => n.toString(16).padStart(40, "0");
const noteSha = sha(100);
const request = { path: "folder/note.md", baseSha: noteSha };
const repo = { owner: "me", repo: "notes" };

/** GitHub の口を真似る。race: 1回目の付け替えの間に、別のコミットが入る（"note" はこのノートが書き換わる） */
function github({ present = true, changed = false, race = "" } = {}) {
  let head = 1;
  const snapshots = new Map([[head, { present, changed }]]);
  const writes: { path: string; method: string; body: any }[] = [];
  let refWrites = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.split("/git")[1]!;
    const method = init.method!;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    if (method !== "GET") writes.push({ path, method, body });
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    if (path === "/ref/heads/main") return json({ object: { sha: sha(head) } });
    if (method === "GET" && path.startsWith("/commits/")) return json({ tree: { sha: "root-" + Number.parseInt(path.split("/").pop()!, 16) } });
    if (path.startsWith("/trees/root-")) return json({ tree: [{ path: "folder", sha: "folder-" + path.split("-").pop(), type: "tree", mode: "040000" }] });
    if (path.startsWith("/trees/folder-")) {
      const s = snapshots.get(Number(path.split("-").pop()))!;
      return json({ tree: s.present ? [{ path: "note.md", sha: s.changed ? sha(101) : noteSha, type: "blob", mode: "100644" }] : [] });
    }
    if (path === "/trees" && method === "POST") return json({ sha: "new-tree" });
    if (path === "/commits" && method === "POST") return json({ sha: sha(300 + head) });
    if (path === "/refs/heads/main" && method === "PATCH") {
      refWrites++;
      if (race && refWrites === 1) {
        const s = snapshots.get(head)!;
        head++;
        snapshots.set(head, { ...s, changed: race === "note" });
        return json({ message: "not fast forward" }, 422);
      }
      return json({ object: { sha: body.sha } });
    }
    throw new Error(`${method} ${path}`);
  });
  return writes;
}

test("delete accepts vault files and rejects traversal, hidden and standard library paths", () => {
  expect(parseDeleteRequest(request)).toEqual(request);
  for (const path of ["../x.md", ".github/workflows/x.yml", "Library/Std/x.md", "x//y.md", "/x.md", "x\\y.md", ""]) {
    expect(parseDeleteRequest({ ...request, path })).toBeNull();
  }
  expect(parseDeleteRequest({ ...request, baseSha: "nope" })).toBeNull();
  expect(parseDeleteRequest(null)).toBeNull();
});

test("the note is removed in one commit when it is still the version that was read", async () => {
  const writes = github();
  expect(await deleteFile("token", repo, "main", request)).toBe(true);
  expect(writes[0]!.body).toEqual({ base_tree: "root-1", tree: [{ path: request.path, mode: "100644", type: "blob", sha: null }] });
  expect(writes[1]!.body.message).toBe("Rootlore: Delete folder/note.md");
  expect(writes[2]!.body).toEqual({ sha: sha(301), force: false });
});

test.each([{ present: false }, { changed: true }])("a note that is gone or was changed is not deleted: %j", async (state) => {
  const writes = github(state);
  expect(await deleteFile("token", repo, "main", request)).toBe(false);
  expect(writes).toEqual([]);
});

test("a commit to another file during the delete is kept; a change to this note stops it", async () => {
  const kept = github({ race: "other" });
  expect(await deleteFile("token", repo, "main", request)).toBe(true);
  expect(kept.filter((w) => w.path === "/commits").map((w) => w.body.parents)).toEqual([[sha(1)], [sha(2)]]);

  const stopped = github({ race: "note" });
  expect(await deleteFile("token", repo, "main", request)).toBe(false);
  expect(stopped.filter((w) => w.method === "PATCH")).toHaveLength(1);
});

test("the delete endpoint returns 409 for a conflict and accepts JSON POST only", async () => {
  github({ changed: true });
  const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    new Request("https://app/api/gh/delete", { method: "POST", headers, body: JSON.stringify(body) });
  const res = await handleDelete(post(request), "token", repo, "main");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "conflict" });
  expect((await handleDelete(new Request("https://app/api/gh/delete"), "token", repo, "main")).status).toBe(405);
  expect((await handleDelete(post(request, {}), "token", repo, "main")).status).toBe(415);
  expect((await handleDelete(post({ path: "Library/Std/x.md", baseSha: noteSha }), "token", repo, "main")).status).toBe(400);
});
