import { describe, expect, test, vi } from "vitest";
import { blobsGraphQL, MAX_BLOBS, proxyGitHub } from "./proxy";

const repo = { owner: "me", repo: "notes" };
const sha = "0123456789abcdef0123456789abcdef01234567";

describe("blobsGraphQL", () => {
  test("builds the blob query for the connected repository from SHAs only", () => {
    const built = blobsGraphQL({ shas: [sha], query: "{ viewer { login } }", variables: { owner: "x" } }, repo)!;
    expect(built.variables).toEqual({ owner: "me", name: "notes" });
    expect(built.query).toContain(`b0: object(oid: "${sha}")`);
    expect(built.query).not.toContain("viewer");
  });

  test.each([
    ["a client query", { query: "query { viewer { login } }" }],
    ["a non-SHA", { shas: [`${sha}") } viewer { login } x: object(oid: "`] }],
    ["an uppercase SHA", { shas: [sha.toUpperCase()] }],
    ["no SHAs", { shas: [] }],
    ["too many SHAs", { shas: Array(MAX_BLOBS + 1).fill(sha) }],
    ["not an object", "query"],
  ])("rejects %s", (_, body) => {
    expect(blobsGraphQL(body, repo)).toBeNull();
  });
});

describe("proxyGitHub", () => {
  const token = "t";
  test.each([
    ["GET", "/repos/me/other/git/trees/main"],
    ["GET", "/repos/me/other"],
    ["GET", "/user"],
    ["DELETE", "/repos/me/notes/git/blobs/0123456789012345678901234567890123456789"],
    ["GET", "/repos/me/notes/git/blobs/../../other"],
    ["PUT", "/repos/me/notes/contents/a.md"],
    ["GET", "/repos/me/other/stats/commit_activity"],
    ["GET", "/repos/me/notes/stats/contributors"],
    // スキルの「追加済み」を見るための contents は、SKILL.md だけ
    ["GET", "/repos/me/notes/contents/.claude/skills/okf/notes.md"],
    ["GET", "/repos/me/notes/contents/.claude/skills/OKF/SKILL.md"],
    ["GET", "/repos/me/notes/contents/.agents/skills/okf"],
    ["GET", "/repos/me/other/contents/.claude/skills/okf/SKILL.md"],
  ])("refuses %s %s without calling GitHub", async (method, path) => {
    const res = await proxyGitHub(new Request("https://app.example/api/gh", { method }), path, token, repo);
    expect(res.status).toBe(403);
  });
});

test("a 401 from GitHub asks the browser to refresh", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ message: "Bad credentials" }, { status: 401 }));
  try {
    const res = await proxyGitHub(
      new Request("https://app.example/api/gh"),
      "/repos/me/notes/commits",
      "t",
      repo,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "refresh" });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("passes the weekly update counts of the connected repository", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    return Response.json([]);
  });
  try {
    const res = await proxyGitHub(
      new Request("https://app.example/api/gh"),
      "/repos/me/notes/stats/commit_activity",
      "t",
      repo,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://api.github.com/repos/me/notes/stats/commit_activity"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("passes the presence of a skill's SKILL.md (for the skills page)", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    return Response.json({ name: "SKILL.md" });
  });
  try {
    const res = await proxyGitHub(
      new Request("https://app.example/api/gh"),
      "/repos/me/notes/contents/.claude/skills/okf/SKILL.md",
      "t",
      repo,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      "https://api.github.com/repos/me/notes/contents/.claude/skills/okf/SKILL.md",
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("passes the connected repository's own information (account page)", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    return Response.json({ full_name: "me/notes" });
  });
  try {
    const res = await proxyGitHub(new Request("https://app.example/api/gh"), "/repos/me/notes", "t", repo);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://api.github.com/repos/me/notes"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("lets the browser keep file lists fetched by SHA, but not by branch", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ tree: [] }));
  try {
    const get = (path: string) =>
      proxyGitHub(new Request("https://app.example/api/gh"), path, "t", repo);
    const bySha = await get(`/repos/me/notes/git/trees/${sha}?recursive=1`);
    expect(bySha.headers.get("Cache-Control")).toContain("immutable");
    const byBranch = await get("/repos/me/notes/git/trees/main?recursive=1");
    expect(byBranch.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    vi.unstubAllGlobals();
  }
});
