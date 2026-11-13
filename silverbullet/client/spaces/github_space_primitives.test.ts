import { afterEach, expect, test, vi } from "vitest";
import { MemoryKvPrimitives } from "../data/memory_kv_primitives.ts";
import { DataStoreSpacePrimitives } from "./datastore_space_primitives.ts";
import { GitHubSpacePrimitives } from "./github_space_primitives.ts";

const repo = { owner: "o", repo: "r", branch: "main" };

function setup(files: Record<string, string>) {
  const tree = Object.entries(files).map(([path, text], i) => ({
    path,
    type: "blob",
    sha: `sha${i}`,
    size: new TextEncoder().encode(text).byteLength,
  }));
  tree.push({ path: ".obsidian/app.json", type: "blob", sha: "x", size: 2 });
  const bySha = new Map(tree.map((t, i) => [t.sha, Object.values(files)[i]]));
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://h/api/gh", "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (url === "http://h/_base_fs/manifest.json") {
      return Response.json([
        {
          name: "Library/Std/Config.md",
          size: 3,
          created: 1,
          lastModified: 1,
          contentType: "text/markdown",
          perm: "ro",
        },
      ]);
    }
    if (path.startsWith("/repos/o/r/git/trees/main")) {
      const headers = init?.headers as Record<string, string>;
      if (headers["If-None-Match"] === '"e1"') {
        return new Response(null, { status: 304 });
      }
      return Response.json(
        { truncated: false, tree },
        { headers: { ETag: '"e1"' } },
      );
    }
    if (path === "/graphql") {
      const { shas } = JSON.parse(init!.body as string) as { shas: string[] };
      const repository: Record<string, unknown> = {};
      for (const [i, sha] of shas.entries()) {
        const text = bySha.get(sha);
        repository[`b${i}`] = sha === "sha1"
          ? { text: null, isBinary: false, isTruncated: true, byteSize: 9 }
          : {
            text,
            isBinary: false,
            isTruncated: false,
            byteSize: new TextEncoder().encode(text!).byteLength,
          };
      }
      return Response.json({ data: { repository } });
    }
    const blob = path.match(/^\/repos\/o\/r\/git\/blobs\/(\w+)$/);
    if (blob) return new Response(bySha.get(blob[1]));
    return new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", { onLine: true });
  const kv = new MemoryKvPrimitives();
  const local = new DataStoreSpacePrimitives(new MemoryKvPrimitives());
  const gh = new GitHubSpacePrimitives(
    "http://h/api/gh",
    "http://h/_base_fs",
    repo,
    kv,
    local,
  );
  return { gh, calls, kv, local };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("lists notes, hides dot folders, overlays Library/Std", async () => {
  const { gh } = setup({ "a.md": "A", "img/p.png": "PNG" });
  const names = (await gh.fetchFileList()).map((f) => f.name).sort();
  expect(names).toEqual(["Library/Std/Config.md", "a.md", "img/p.png"]);
  const meta = await gh.getFileMeta("a.md");
  expect(meta.perm).toBe("ro");
  expect(meta.contentType).toBe("text/markdown");
});

test("reads notes in one GraphQL batch, falls back to REST when truncated", async () => {
  const { gh, calls } = setup({
    "a.md": "A",
    "big.md": "truncated",
    "c.md": "日本語",
  });
  await gh.fetchFileList();
  const texts = await Promise.all(
    ["a.md", "big.md", "c.md"].map(async (p) =>
      new TextDecoder().decode((await gh.readFile(p)).data)
    ),
  );
  expect(texts).toEqual(["A", "truncated", "日本語"]);
  expect(calls.filter((c) => c === "POST /graphql")).toHaveLength(1);
  expect(calls).toContain("GET /repos/o/r/git/blobs/sha1");
  expect(gh.stats.graphqlRequests).toBe(1);
});

test("keeps lastModified stable while the blob is unchanged, reuses tree on 304", async () => {
  const { gh } = setup({ "a.md": "A" });
  const first = await gh.fetchFileList();
  const second = await gh.fetchFileList();
  const lm = (files: typeof first) =>
    files.find((f) => f.name === "a.md")!.lastModified;
  expect(lm(second)).toBe(lm(first));
  expect(gh.stats.tree304).toBe(1);
});

test("does not prefetch notes the local store already has", async () => {
  const { gh, local, calls } = setup({ "a.md": "A" });
  const [meta] = (await gh.fetchFileList()).filter((f) => f.name === "a.md");
  await gh.readFile("a.md");
  await local.writeFile("a.md", new TextEncoder().encode("A"), meta);
  calls.length = 0;
  await gh.fetchFileList();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).not.toContain("POST /graphql");
});

test("refreshes an expired token once and retries the requests", async () => {
  const { gh, calls } = setup({ "a.md": "hello" });
  const realFetch = globalThis.fetch as unknown as (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
  let refreshed = false;
  let refreshCalls = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "http://h/.auth/refresh") {
      refreshCalls++;
      refreshed = true;
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("http://h/api/gh") && !refreshed) {
      return Response.json({ error: "refresh" }, { status: 401 });
    }
    return realFetch(url, init);
  });
  const files = await gh.fetchFileList();
  expect(files.map((f) => f.name)).toContain("a.md");
  expect(refreshCalls).toBe(1);
  expect(calls.some((c) => c.startsWith("GET /repos/o/r/git/trees/main"))).toBe(true);
});

test("does not refresh when the login is gone", async () => {
  const { gh } = setup({ "a.md": "hello" });
  let refreshCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "http://h/.auth/refresh") refreshCalls++;
    if (url === "http://h/_base_fs/manifest.json") return Response.json([]);
    return Response.json({ error: "login" }, { status: 401 });
  });
  await expect(gh.fetchFileList()).rejects.toThrow();
  expect(refreshCalls).toBe(0);
});

// --- まだ GitHub に繋いでいないときの見本（デモ） ---

function demoSetup() {
  const manifest = [
    { name: "Library/Std/Config.md", size: 3, created: 1, lastModified: 1, contentType: "text/markdown", perm: "ro" },
    { name: "Library/Std/Rootlore/Demo/ja/はじめに.md", size: 5, created: 1, lastModified: 1, contentType: "text/markdown", perm: "ro" },
    { name: "Library/Std/Rootlore/Demo/ja/デモ/計画.md", size: 5, created: 1, lastModified: 1, contentType: "text/markdown", perm: "ro" },
    { name: "Library/Std/Rootlore/Demo/en/Getting started.md", size: 5, created: 1, lastModified: 1, contentType: "text/markdown", perm: "ro" },
    { name: "Library/Std/Rootlore/Demo/en/Demo/Plan.md", size: 5, created: 1, lastModified: 1, contentType: "text/markdown", perm: "ro" },
  ];
  const texts: Record<string, string> = {
    "Library/Std/Rootlore/Demo/ja/はじめに.md": "にほんご",
    "Library/Std/Rootlore/Demo/ja/デモ/計画.md": "けいかく",
    "Library/Std/Rootlore/Demo/en/Getting started.md": "english",
    "Library/Std/Rootlore/Demo/en/Demo/Plan.md": "plan",
  };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/manifest.json")) return Response.json(manifest);
    const path = url.replace("http://h/_base_fs/", "");
    const decoded = decodeURIComponent(path);
    return texts[decoded] === undefined ? new Response("nope", { status: 404 }) : new Response(texts[decoded]);
  });
  vi.stubGlobal("navigator", { onLine: true });
  const gh = new GitHubSpacePrimitives(
    "http://h/api/gh",
    "http://h/_base_fs",
    { owner: "", repo: "", branch: "", disconnected: true },
    new MemoryKvPrimitives(),
    new DataStoreSpacePrimitives(new MemoryKvPrimitives()),
  );
  return gh;
}

test("まだ繋いでいないときは、日本語の画面なら日本語の見本を出す", async () => {
  const gh = demoSetup();
  gh.setUiLanguage("ja");
  const names = (await gh.fetchFileList()).map((f) => f.name);
  expect(names).toContain("はじめに.md");
  expect(names).toContain("デモ/計画.md");
  // 英語の見本は出さない（標準ライブラリの一覧には入っているが、見本としては出さない）
  expect(names.some((n) => n.includes("/Rootlore/Demo/en/"))).toBe(false);
  expect(names.some((n) => n === "Getting started.md")).toBe(false);
  // 標準ライブラリは今までどおり
  expect(names).toContain("Library/Std/Config.md");
});

test("英語の画面なら、英語の見本を出す", async () => {
  const gh = demoSetup();
  gh.setUiLanguage("en");
  const names = (await gh.fetchFileList()).map((f) => f.name);
  expect(names).toContain("Getting started.md");
  expect(names).toContain("Demo/Plan.md");
  expect(names.some((n) => n.includes("/Rootlore/Demo/ja/"))).toBe(false);
  expect(names.some((n) => n === "はじめに.md")).toBe(false);
});

test("見本の本文は、一覧に出した名前で読める", async () => {
  const gh = demoSetup();
  gh.setUiLanguage("ja");
  const { data, meta } = await gh.readFile("はじめに.md");
  expect(new TextDecoder().decode(data)).toBe("にほんご");
  expect(meta.name).toBe("はじめに.md");
  // 一覧の名前でも、メタ情報が取れる
  expect((await gh.getFileMeta("デモ/計画.md")).name).toBe("デモ/計画.md");
});

test("繋いだあとは、見本を出さない", async () => {
  const gh = demoSetup();
  gh.setUiLanguage("ja");
  // 繋いだ状態に切り替える（GitHub の一覧は空）
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/manifest.json")) {
      return Response.json([
        { name: "Library/Std/Config.md", size: 3, created: 1, lastModified: 1, contentType: "text/markdown", perm: "ro" },
      ]);
    }
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [] }, { headers: { ETag: '"e"' } });
    return new Response("nope", { status: 404 });
  });
  const connected = new GitHubSpacePrimitives(
    "http://h/api/gh",
    "http://h/_base_fs",
    repo,
    new MemoryKvPrimitives(),
    new DataStoreSpacePrimitives(new MemoryKvPrimitives()),
  );
  connected.setUiLanguage("ja");
  const names = (await connected.fetchFileList()).map((f) => f.name);
  expect(names.some((n) => n.includes("/Rootlore/Demo/"))).toBe(false);
  expect(names).toContain("Library/Std/Config.md");
});
