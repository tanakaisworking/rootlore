import { afterEach, describe, expect, test, vi } from "vitest";
import {
  commitFiles,
  commitHeadline,
  handleCommit,
  headQuery,
  isConflictCopy,
  isSkillLinkPath,
  isSkillLinkTarget,
  isSkillPath,
  isWritablePath,
  MAX_FILE_BYTES,
  parseCommitRequest,
} from "./commit";

const repo = { owner: "me", repo: "notes" };
const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWritablePath", () => {
  test.each(["a.md", "日記/2026-11-03.md", "a b/c.md", ".claude/skills/okf/SKILL.md"])(
    "allows %s",
    (path) => {
      expect(isWritablePath(path)).toBe(true);
    },
  );
  test.each([
    "",
    "a.png",
    "/a.md",
    "a//b.md",
    "../a.md",
    "a/../b.md",
    ".obsidian/x.md",
    "a/.git/x.md",
    "Library/Std/Config.md",
    "a\\b.md",
    "a\nb.md",
    "C:x.md",
    // スキルでも、SKILL.md 以外と id の形が違うものは書かない
    ".claude/skills/okf/notes.md",
    ".claude/skills/okf/scripts/run.md",
    ".claude/skills/OKF/SKILL.md",
    ".claude/skills/okf--x/SKILL.md",
    ".agents/skills/okf",
  ])("refuses %j", (path) => {
    expect(isWritablePath(path)).toBe(false);
  });
});

describe("skill paths", () => {
  test("the body is .claude/skills/<id>/SKILL.md", () => {
    expect(isSkillPath(".claude/skills/okf/SKILL.md")).toBe(true);
    expect(isSkillPath(".claude/skills/okf/README.md")).toBe(false);
    expect(isSkillPath(".claude/skills/okf")).toBe(false);
  });
  test("the link is .agents/skills/<id>", () => {
    expect(isSkillLinkPath(".agents/skills/okf")).toBe(true);
    expect(isSkillLinkPath(".agents/skills/okf/SKILL.md")).toBe(false);
    expect(isSkillLinkPath(".claude/skills/okf")).toBe(false);
  });
  test("the link may only point at the same id under .claude/skills", () => {
    expect(isSkillLinkTarget(".agents/skills/okf", "../../.claude/skills/okf")).toBe(true);
    expect(isSkillLinkTarget(".agents/skills/okf", "../../.claude/skills/other")).toBe(false);
    expect(isSkillLinkTarget(".agents/skills/okf", ".claude/skills/okf")).toBe(false);
    expect(isSkillLinkTarget(".agents/skills/okf", "../../../etc/passwd")).toBe(false);
  });
});

test("only conflict copies can be deleted", () => {
  expect(isConflictCopy("日記/買い物.conflicted-20261104-153000.md")).toBe(true);
  expect(isConflictCopy("日記/買い物.md")).toBe(false);
  expect(isConflictCopy(".git/x.conflicted-1.md")).toBe(false);
});

describe("parseCommitRequest", () => {
  const file = { path: "a.md", content: b64("hi"), baseSha: shaA };
  test("accepts new and existing files", () => {
    expect(parseCommitRequest({ files: [file, { path: "b.md", content: "", baseSha: null }] })).toEqual({
      files: [file, { path: "b.md", content: "", baseSha: null }],
      symlinks: [],
      deletions: [],
    });
  });
  test("accepts a message and the deletion of a conflict copy", () => {
    const deletion = { path: "a.conflicted-20261104-153000.md", baseSha: shaB };
    expect(parseCommitRequest({ files: [file], deletions: [deletion], message: " 食い違いを直す " })).toEqual({
      files: [file],
      symlinks: [],
      deletions: [deletion],
      message: "食い違いを直す",
    });
  });
  test("accepts a skill body and its symlink in one request", () => {
    const skill = { path: ".claude/skills/okf/SKILL.md", content: b64("---\nname: okf\n---\n"), baseSha: null };
    const link = { path: ".agents/skills/okf", target: "../../.claude/skills/okf", baseSha: null };
    expect(parseCommitRequest({ files: [skill], symlinks: [link] })).toEqual({
      files: [skill],
      symlinks: [link],
      deletions: [],
    });
  });
  test.each([
    ["no files", { files: [] }],
    ["a duplicate path", { files: [file, file] }],
    ["a bad path", { files: [{ ...file, path: ".git/config.md" }] }],
    ["a bad SHA", { files: [{ ...file, baseSha: "HEAD" }] }],
    ["non-base64 content", { files: [{ ...file, content: "not base64!" }] }],
    ["too large a file", { files: [{ ...file, content: "A".repeat(((MAX_FILE_BYTES + 3) / 3) * 4) }] }],
    ["deleting a note", { files: [file], deletions: [{ path: "b.md", baseSha: shaA }] }],
    ["deleting without a SHA", { files: [file], deletions: [{ path: "b.conflicted-1.md", baseSha: null }] }],
    ["writing and deleting one path", { files: [{ ...file, path: "a.conflicted-1.md" }], deletions: [{ path: "a.conflicted-1.md", baseSha: shaA }] }],
    ["a multi-line message", { files: [file], message: "a\nb" }],
    ["an empty message", { files: [file], message: "  " }],
    ["not an object", "x"],
    // symlink はスキルの写しだけ。指す先も同じ id に限る
    ["a link outside .agents/skills", { files: [file], symlinks: [{ path: "okf", target: "../../.claude/skills/okf", baseSha: null }] }],
    ["a link to another id", { files: [file], symlinks: [{ path: ".agents/skills/okf", target: "../../.claude/skills/other", baseSha: null }] }],
    ["a link with a bad SHA", { files: [file], symlinks: [{ path: ".agents/skills/okf", target: "../../.claude/skills/okf", baseSha: "HEAD" }] }],
    ["a file and a link on one path", { files: [{ ...file, path: ".claude/skills/okf/SKILL.md" }], symlinks: [{ path: ".claude/skills/okf/SKILL.md", target: "../../.claude/skills/okf", baseSha: null }] }],
  ])("refuses %s", (_, body) => {
    expect(parseCommitRequest(body)).toBeNull();
  });
});

test("commitHeadline names the first note", () => {
  expect(commitHeadline(["日記/買い物.md"])).toBe("Rootlore: 買い物");
  expect(commitHeadline(["a.md", "b.md", "c.md"])).toBe("Rootlore: a ほか2件");
});

test("headQuery passes paths as variables, not inside the query", () => {
  const built = headQuery(repo, "main", ['x") { oid } evil: file(path: "y.md']);
  expect(built.query).not.toContain("evil");
  expect(built.variables).toMatchObject({ owner: "me", name: "notes", ref: "refs/heads/main" });
});

function githubMock(handlers: ((body: any) => unknown)[]) {
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      return Response.json(handlers.shift()!(body));
    }),
  );
  return bodies;
}

const files = [
  { path: "a.md", content: b64("new a"), baseSha: shaA },
  { path: "new.md", content: b64("new"), baseSha: null },
];
/** GitHub が「ない」ファイルに付けるエラー */
const notFound = (field: string) => ({
  type: "NOT_FOUND",
  path: ["repository", "ref", "target", field],
  message: "Could not resolve file for path 'x'.",
});
/** 1件目（a.md）の版が a、2件目（new.md）は GitHub にない。count は送ったファイルの数 */
const head = (oid: string, a: string | null, count = 2) => ({
  data: { repository: { ref: { target: { oid, f0: a && { oid: a, type: "blob" }, ...(count > 1 ? { f1: null } : {}) } } } },
  errors: [...(a ? [] : [notFound("f0")]), ...(count > 1 ? [notFound("f1")] : [])],
});

function restMock(routes: Record<string, (body: any) => unknown>) {
  const calls: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = url.replace("https://api.github.com", "");
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      const handler = routes[`${method} ${path}`];
      if (!handler) return new Response("", { status: 404 });
      return Response.json(handler(body));
    }),
  );
  return calls;
}

const skillFile = {
  path: ".claude/skills/okf/SKILL.md",
  content: b64("---\nname: okf\n---\n"),
  baseSha: null,
};
const skillLink = { path: ".agents/skills/okf", target: "../../.claude/skills/okf", baseSha: null };

test("a skill and its symlink go through the Git Data API, with mode 120000", async () => {
  const calls = restMock({
    "POST /graphql": () => head("c1", null, 2),
    "GET /repos/me/notes/git/commits/c1": () => ({ tree: { sha: "t1" } }),
    "POST /repos/me/notes/git/blobs": (body) => ({ sha: body.content === skillFile.content ? "b1" : "b2" }),
    "POST /repos/me/notes/git/trees": () => ({ sha: "t2" }),
    "POST /repos/me/notes/git/commits": () => ({ sha: "c2" }),
    "PATCH /repos/me/notes/git/refs/heads/main": () => ({}),
  });
  const outcome = await commitFiles("t", repo, "main", {
    files: [skillFile],
    symlinks: [skillLink],
    deletions: [],
  });
  expect(outcome).toMatchObject({ status: "committed", commit: "c2" });
  const tree = calls.find((call) => call.path === "/repos/me/notes/git/trees")!;
  expect(tree.body.base_tree).toBe("t1");
  expect(tree.body.tree).toEqual([
    { path: skillFile.path, mode: "100644", type: "blob", sha: "b1" },
    { path: skillLink.path, mode: "120000", type: "blob", sha: "b2" },
  ]);
  // symlink の中身は、指す先の文字列そのもの
  const blobs = calls.filter((call) => call.path === "/repos/me/notes/git/blobs");
  expect(atob(blobs[1]!.body.content)).toBe(skillLink.target);
  const commit = calls.find((call) => call.method === "POST" && call.path === "/repos/me/notes/git/commits")!;
  expect(commit.body.parents).toEqual(["c1"]);
  expect(commit.body.tree).toBe("t2");
  expect(commit.body.message).toContain("Rootlore: SKILL");
});

test("a skill already on GitHub is a conflict, and nothing is written", async () => {
  const calls = restMock({ "POST /graphql": () => head("c1", shaA, 1) });
  const outcome = await commitFiles("t", repo, "main", {
    files: [{ ...skillFile, baseSha: null }],
    symlinks: [],
    deletions: [],
  });
  expect(outcome).toEqual({ status: "conflict", conflicts: [{ path: skillFile.path, sha: shaA }] });
  expect(calls).toHaveLength(1);
});

test("commits when every file is still at its base", async () => {
  const bodies = githubMock([
    () => head("c1", shaA),
    () => ({ data: { createCommitOnBranch: { commit: { oid: "c2" } } } }),
  ]);
  const outcome = await commitFiles("t", repo, "main", { files, deletions: [] });
  // 書いたファイルの版は、送った本文から計算する（git hash-object と同じ）
  expect(outcome).toEqual({
    status: "committed",
    commit: "c2",
    files: [{ path: "a.md", sha: "a5fa93545312bc17d79136900d84395693d5c80b" }, { path: "new.md", sha: "3e5126c4e761fd09582fc517918a1601b218dff0" }],
  });
  const input = bodies[1].variables.input;
  expect(input.expectedHeadOid).toBe("c1");
  expect(input.branch).toEqual({ repositoryNameWithOwner: "me/notes", branchName: "main" });
  expect(input.fileChanges.additions).toEqual([
    { path: "a.md", contents: b64("new a") },
    { path: "new.md", contents: b64("new") },
  ]);
  expect(input.message.headline).toBe("Rootlore: a ほか1件");
});

test("returns conflicts without committing when GitHub has moved on", async () => {
  const bodies = githubMock([
    () => ({ data: { repository: { ref: { target: { oid: "c1", f0: { oid: shaB, type: "blob" }, f1: { oid: shaA, type: "blob" } } } } } }),
  ]);
  const outcome = await commitFiles("t", repo, "main", { files, deletions: [] });
  expect(outcome).toEqual({
    status: "conflict",
    conflicts: [{ path: "a.md", sha: shaB }, { path: "new.md", sha: shaA }],
  });
  expect(bodies).toHaveLength(1);
});

test("a note deleted on GitHub is a conflict with no SHA", async () => {
  githubMock([() => head("c1", null, 1)]);
  const outcome = await commitFiles("t", repo, "main", { files: [files[0]!], deletions: [] });
  expect(outcome).toEqual({ status: "conflict", conflicts: [{ path: "a.md", sha: null }] });
});

test("checks again when the branch moved between the check and the commit", async () => {
  githubMock([
    () => head("c1", shaA),
    () => ({ errors: [{ message: 'Expected branch to point to "c1" but it did not. Pull and try again.' }] }),
    () => head("c3", shaA),
    () => ({ data: { createCommitOnBranch: { commit: { oid: "c4" } } } }),
  ]);
  const outcome = await commitFiles("t", repo, "main", { files, deletions: [] });
  expect(outcome.status).toBe("committed");
});

test("a NOT_FOUND for another kind of field is not taken as a missing note", async () => {
  const bodies = githubMock([
    () => ({ ...head("c1", shaA), errors: [notFound("f1"), { ...notFound("f1"), path: ["repository", "ref"] }] }),
  ]);
  await expect(commitFiles("t", repo, "main", { files, deletions: [] })).rejects.toThrow();
  expect(bodies).toHaveLength(1);
});

test("an empty field without a NOT_FOUND is not taken as a missing note", async () => {
  const bodies = githubMock([() => ({ ...head("c1", shaA), errors: [] })]);
  await expect(commitFiles("t", repo, "main", { files, deletions: [] })).rejects.toThrow("new.md came back empty");
  expect(bodies).toHaveLength(1);
});

test("does not commit when the check came back only partly", async () => {
  // 新しいノートの欄が null でも、エラーが付いていれば「GitHub にない」とはみなさない
  const bodies = githubMock([
    () => ({ ...head("c1", shaA), errors: [{ message: "Something went wrong while executing your query." }] }),
  ]);
  await expect(commitFiles("t", repo, "main", { files, deletions: [] })).rejects.toThrow("Something went wrong");
  expect(bodies).toHaveLength(1);
  // 欄そのものが返ってこなかったときも同じ
  const missing = githubMock([() => ({ data: { repository: { ref: { target: { oid: "c1", f0: { oid: shaA, type: "blob" } } } } } })]);
  await expect(commitFiles("t", repo, "main", { files, deletions: [] })).rejects.toThrow("new.md was not returned");
  expect(missing).toHaveLength(1);
});

test("a commit that was made counts as saved even if GitHub adds an error", async () => {
  // 失敗と返すと、CLI の append を再実行したときに同じ本文が二重に足される
  githubMock([
    () => head("c1", shaA),
    () => ({ data: { createCommitOnBranch: { commit: { oid: "c2" } } }, errors: [{ message: "Something went wrong" }] }),
  ]);
  const outcome = await commitFiles("t", repo, "main", { files, deletions: [] });
  expect(outcome).toMatchObject({ status: "committed", commit: "c2" });
});

test("deletes a conflict copy in the same commit, checking its SHA too", async () => {
  const copy = { path: "a.conflicted-20261104-153000.md", baseSha: shaB };
  const bodies = githubMock([
    () => ({ data: { repository: { ref: { target: { oid: "c1", f0: { oid: shaA, type: "blob" }, f1: { oid: shaB, type: "blob" } } } } } }),
    () => ({ data: { createCommitOnBranch: { commit: { oid: "c2" } } } }),
  ]);
  const outcome = await commitFiles("t", repo, "main", { files: [files[0]!], deletions: [copy], message: "直した" });
  expect(outcome).toEqual({ status: "committed", commit: "c2", files: [{ path: "a.md", sha: "a5fa93545312bc17d79136900d84395693d5c80b" }] });
  expect(bodies[0].variables).toMatchObject({ p0: "a.md", p1: copy.path });
  const input = bodies[1].variables.input;
  expect(input.fileChanges.deletions).toEqual([{ path: copy.path }]);
  expect(input.message.headline).toBe("直した");
  expect(bodies[1].variables).not.toHaveProperty("p1");
});

test("a conflict copy changed since it was read is a conflict", async () => {
  const copy = { path: "a.conflicted-1.md", baseSha: shaB };
  githubMock([
    () => ({ data: { repository: { ref: { target: { oid: "c1", f0: { oid: shaA, type: "blob" }, f1: { oid: shaA, type: "blob" } } } } } }),
  ]);
  const outcome = await commitFiles("t", repo, "main", { files: [files[0]!], deletions: [copy] });
  expect(outcome).toEqual({ status: "conflict", conflicts: [{ path: copy.path, sha: shaA }] });
});

test("refuses a path that is a folder on GitHub", async () => {
  githubMock([
    () => ({ data: { repository: { ref: { target: { oid: "c1", f0: { oid: shaA, type: "tree" } } } } } }),
  ]);
  await expect(commitFiles("t", repo, "main", { files: [files[0]!], deletions: [] })).rejects.toThrow("not a file");
});

describe("handleCommit", () => {
  const post = (body: unknown) =>
    new Request("https://app.example/api/gh/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("refuses a bad request without calling GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleCommit(post({ files: [{ path: "a.png", content: "", baseSha: null }] }), "t", repo, "main");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses a body that is not JSON (a form from another site)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("https://app.example/api/gh/commit", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ files: [files[0]] }),
    });
    expect((await handleCommit(req, "t", repo, "main")).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("answers 409 with the current SHAs", async () => {
    githubMock([() => head("c1", shaB, 1)]);
    const res = await handleCommit(post({ files: [files[0]] }), "t", repo, "main");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ conflicts: [{ path: "a.md", sha: shaB }] });
  });

  test("a 401 from GitHub asks the browser to refresh", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    const res = await handleCommit(post({ files: [files[0]] }), "t", repo, "main");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "refresh" });
  });
});
