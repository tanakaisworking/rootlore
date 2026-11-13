import { afterEach, expect, test, vi } from "vitest";
import { handleMove, moveFile, parseMoveRequest } from "./move";

afterEach(() => vi.unstubAllGlobals());
const sha = (n: number) => n.toString(16).padStart(40, "0");
const sourceSha = sha(100);
const request = { source: "image.png", destination: "folder/image.png", baseSha: sourceSha };
const repo = { owner: "me", repo: "notes" };

function github({ source = true, changed = false, occupied = false, blocked = false, race = "", mode = "100644" } = {}) {
  let head = 1;
  const snapshots = new Map([[head, { source, changed, occupied, blocked }]]);
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
    if (path.startsWith("/trees/root-")) {
      const snapshot = snapshots.get(Number(path.split("-").pop()))!;
      return json({ tree: [
        ...(snapshot.source ? [{ path: "image.png", sha: snapshot.changed ? sha(101) : sourceSha, type: "blob", mode }] : []),
        { path: "folder", sha: "folder-" + path.split("-").pop(), type: snapshot.blocked ? "blob" : "tree", mode: "040000" },
      ] });
    }
    if (path.startsWith("/trees/folder-")) {
      const snapshot = snapshots.get(Number(path.split("-").pop()))!;
      return json({ tree: snapshot.occupied ? [{ path: "image.png", sha: sha(200), type: "blob", mode }] : [] });
    }
    if (path === "/trees" && method === "POST") return json({ sha: "new-tree" });
    if (path === "/commits" && method === "POST") return json({ sha: sha(300 + head) });
    if (path === "/refs/heads/main" && method === "PATCH") {
      refWrites++;
      if (race && (refWrites === 1 || race === "busy")) {
        const snapshot = snapshots.get(head)!;
        head++;
        snapshots.set(head, { ...snapshot, changed: race === "source", occupied: race === "destination" });
        return json({ message: "not fast forward" }, 422);
      }
      return json({ object: { sha: body.sha } });
    }
    throw new Error(`${method} ${path}`);
  });
  return writes;
}

test("move accepts all visible file types and rejects traversal and standard library paths", () => {
  expect(parseMoveRequest(request)).toEqual(request);
  for (const path of ["../x.md", ".github/workflows/x.yml", "Library/Std/x.md", "x//y", "/x", "x\\y", "x\u0000y"]) {
    expect(parseMoveRequest({ ...request, source: path })).toBeNull();
    expect(parseMoveRequest({ ...request, destination: path })).toBeNull();
  }
  expect(parseMoveRequest({ ...request, destination: request.source })).toBeNull();
  expect(parseMoveRequest({ ...request, destination: request.source + "/child" })).toBeNull();
  expect(parseMoveRequest({ ...request, baseSha: null })).toBeNull();
});

test.each(["100644", "100755", "120000"])("move reuses the blob and preserves mode %s in one commit", async (mode) => {
  const writes = github({ mode });
  expect(await moveFile("token", repo, "main", request)).toBe(true);
  expect(writes[0]!.body).toEqual({ base_tree: "root-1", tree: [
    { path: request.source, mode, type: "blob", sha: null },
    { path: request.destination, mode, type: "blob", sha: sourceSha },
  ] });
  expect(writes[1]!.body.parents).toEqual([sha(1)]);
  expect(writes[2]!.body).toEqual({ sha: sha(301), force: false });
});

test.each([{ source: false }, { changed: true }, { occupied: true }, { blocked: true }])("a stale source or occupied destination changes nothing: %j", async (state) => {
  const writes = github(state);
  expect(await moveFile("token", repo, "main", request)).toBe(false);
  expect(writes).toEqual([]);
});

test("an unrelated concurrent commit is retained as the parent of the retried move", async () => {
  const writes = github({ race: "unrelated" });
  expect(await moveFile("token", repo, "main", request)).toBe(true);
  const commits = writes.filter((w) => w.path === "/commits");
  expect(commits.map((w) => w.body.parents)).toEqual([[sha(1)], [sha(2)]]);
  expect(writes.filter((w) => w.path === "/trees").map((w) => w.body.base_tree)).toEqual(["root-1", "root-2"]);
});

test.each(["source", "destination", "busy"])("concurrent %s updates stop the move without forcing the branch", async (race) => {
  const writes = github({ race });
  expect(await moveFile("token", repo, "main", request)).toBe(false);
  expect(writes.filter((w) => w.method === "PATCH").every((w) => w.body.force === false)).toBe(true);
  expect(writes.filter((w) => w.method === "PATCH")).toHaveLength(race === "busy" ? 3 : 1);
});

test("the move endpoint returns 409 for a conflict and accepts JSON POST only", async () => {
  github({ changed: true });
  const res = await handleMove(new Request("https://app/api/gh/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }), "token", repo, "main");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "conflict" });
  expect((await handleMove(new Request("https://app/api/gh/move"), "token", repo, "main")).status).toBe(405);
  expect((await handleMove(new Request("https://app/api/gh/move", { method: "POST", body: JSON.stringify(request) }), "token", repo, "main")).status).toBe(415);
});
