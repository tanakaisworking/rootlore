// 通しの確認。部品ごとのテストは別にあるが、ここでは「利用者が順に操作したら壊れないか」を、
// Worker と GitHub（偽物）を通して確かめる。
//
// 確かめる流れ:
//   1. ログイン → 設定 → ノート一覧 → 本文
//   2. ノートを直して保存 → GitHub に1つのコミットとして届く
//   3. 2台目が先に直していたら、上書きせずに食い違いとして知らせる
//   4. ファイルの移動
//   5. ログアウトすると、セッションが消える
//
// GitHub は偽物（fetch を差し替える）。本物の API は叩かない

import { afterEach, expect, test, vi } from "vitest";
import app from "./index";
import { seal } from "./session";
import { saveAppConfig } from "./app_config";
import type { Env } from "./env";

// Cloudflare Workers だけにある関数の代わり（テストは Node で動くため）
if (!("timingSafeEqual" in crypto.subtle)) {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: (a: ArrayBufferView, b: ArrayBufferView) => {
      const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      return x.length === y.length && x.every((v, i) => v === y[i]);
    },
  });
}

const secret = "x".repeat(32);
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** テストだけの KV */
function fakeKv(store = new Map<string, string>()): KVNamespace {
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
}

async function makeEnv(): Promise<Env> {
  const kv = fakeKv();
  await saveAppConfig(kv, secret, {
    id: 1,
    slug: "rootlore-me",
    clientId: "cid",
    clientSecret: "csecret",
    htmlUrl: "https://github.com/apps/rootlore-me",
  });
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    APP_KV: kv,
    ALLOWED_LOGINS: "me,friend",
    ADMIN_LOGINS: "me",
    SESSION_SECRET: secret,
  } as Env;
}

async function sessionCookie(login = "me"): Promise<string> {
  const session = {
    login,
    repo: { owner: "me", repo: "notes", branch: "main" },
    accessToken: "token",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshToken: "refresh",
    refreshTokenExpiresAt: Date.now() + 86_400_000,
  };
  return `vw_session=${await seal(session, secret)}`;
}

/** GitHub の応答を、URL と method で振り分ける偽物 */
type Route = (url: string, init: RequestInit) => Response | undefined;

function fakeGitHub(routes: Route[]) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: typeof init.body === "string" ? init.body : undefined });
      for (const route of routes) {
        const response = route(url, init);
        if (response) return response;
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("ログインした端末は、設定・ノート一覧・本文まで届く", async () => {
  const env = await makeEnv();
  const cookie = await sessionCookie();
  fakeGitHub([
    (url) =>
      url.includes("/repos/me/notes/git/trees/main")
        ? Response.json({
            truncated: false,
            tree: [
              { path: "日記/11-07.md", type: "blob", sha: sha(1), size: 20 },
              { path: "日記", type: "tree", sha: sha(2) },
            ],
          })
        : undefined,
    (url) =>
      url.endsWith("/graphql")
        ? Response.json({
            data: { repository: { b0: { text: "# 11月7日\n", isBinary: false, isTruncated: false, byteSize: 10 } } },
          })
        : undefined,
  ]);

  // 1. 設定（画面が起動時に読む）
  const config = await app.request("https://app.example/v/.config", { headers: { Cookie: cookie } }, env);
  expect(config.status).toBe(200);
  const boot = (await config.json()) as { githubRepo: { owner: string; repo: string; branch: string } };
  expect(boot.githubRepo).toEqual({ owner: "me", repo: "notes", branch: "main" });

  // 2. ノート一覧（Service Worker が読む口）
  const tree = await app.request("https://app.example/v/api/gh/repos/me/notes/git/trees/main?recursive=1", {
    headers: { Cookie: cookie },
  }, env);
  expect(tree.status).toBe(200);
  const listing = (await tree.json()) as { tree: { path: string }[] };
  expect(listing.tree.map((item) => item.path)).toContain("日記/11-07.md");

  // 3. 本文（まとめて読む口）
  const blobs = await app.request(
    "https://app.example/v/api/gh/graphql",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ shas: [sha(1)] }),
    },
    env,
  );
  expect(blobs.status).toBe(200);
  const content = (await blobs.json()) as { data: { repository: { b0: { text: string } } } };
  expect(content.data.repository.b0.text).toBe("# 11月7日\n");
});

test("直したノートは、1つのコミットとして GitHub に届く", async () => {
  const env = await makeEnv();
  const cookie = await sessionCookie();
  // 1回目は「今の版を確かめる」、2回目は「コミットする」。順に返す
  const responses = [
    Response.json({
      data: { repository: { ref: { target: { oid: sha(9), f0: { oid: sha(1), type: "blob" } } } } },
    }),
    Response.json({ data: { createCommitOnBranch: { commit: { oid: sha(8) } } } }),
  ];
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return responses.shift()!;
    }),
  );

  const res = await app.request(
    "https://app.example/v/api/gh/commit",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "日記/11-07.md", content: b64("# 11月7日（直した）\n"), baseSha: sha(1) }],
      }),
    },
    env,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { commit: string; files: { path: string; sha: string }[] };
  expect(body.commit).toBe(sha(8));
  expect(body.files.map((f) => f.path)).toEqual(["日記/11-07.md"]);

  // 1回目は版の確認、2回目はコミット。どちらも1回ずつ
  expect(bodies).toHaveLength(2);
  const mutation = bodies[1];
  expect(mutation.query).toContain("createCommitOnBranch");
  const input = mutation.variables.input;
  expect(input.branch).toEqual({ repositoryNameWithOwner: "me/notes", branchName: "main" });
  expect(input.expectedHeadOid).toBe(sha(9));
  expect(input.fileChanges.additions).toEqual([
    { path: "日記/11-07.md", contents: b64("# 11月7日（直した）\n") },
  ]);
});

test("2台目が先に直していたら、上書きせずに食い違いとして返す", async () => {
  const env = await makeEnv();
  const cookie = await sessionCookie();
  fakeGitHub([
    (url) =>
      url.endsWith("/graphql")
        ? Response.json({
            data: {
              // GitHub 側は sha(7) になっている。この端末が読んだのは sha(1)
              repository: { ref: { target: { oid: sha(9), f0: { oid: sha(7), type: "blob" } } } },
            },
          })
        : undefined,
  ]);

  const res = await app.request(
    "https://app.example/v/api/gh/commit",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "日記/11-07.md", content: b64("# この端末の版\n"), baseSha: sha(1) }],
      }),
    },
    env,
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ conflicts: [{ path: "日記/11-07.md", sha: sha(7) }] });
});

test("ファイルの移動は、移動元の版が合っていれば通る", async () => {
  const env = await makeEnv();
  const cookie = await sessionCookie();
  const treeSha = sha(3);
  const rootSha = sha(4);
  fakeGitHub([
    (url) =>
      url.includes("/git/ref/heads/main")
        ? Response.json({ object: { sha: sha(9) } })
        : undefined,
    (url) =>
      url.endsWith(`/git/commits/${sha(9)}`)
        ? Response.json({ tree: { sha: rootSha } })
        : undefined,
    (url) =>
      url.endsWith(`/git/trees/${rootSha}`)
        ? Response.json({
            truncated: false,
            tree: [
              { path: "日記", type: "tree", sha: treeSha, mode: "040000" },
            ],
          })
        : undefined,
    (url) =>
      url.endsWith(`/git/trees/${treeSha}`)
        ? Response.json({
            truncated: false,
            tree: [{ path: "11-07.md", type: "blob", sha: sha(1), mode: "100644" }],
          })
        : undefined,
    (url, init) =>
      url.endsWith("/git/trees") && init.method === "POST"
        ? Response.json({ sha: sha(5) })
        : undefined,
    (url, init) =>
      url.endsWith("/git/commits") && init.method === "POST"
        ? Response.json({ sha: sha(6) })
        : undefined,
    (url, init) =>
      url.includes("/git/refs/heads/main") && init.method === "PATCH"
        ? Response.json({ object: { sha: sha(6) } })
        : undefined,
  ]);

  const res = await app.request(
    "https://app.example/v/api/gh/move",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "日記/11-07.md", destination: "日記/11-08.md", baseSha: sha(1) }),
    },
    env,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ moved: true });
});

test("ログアウトすると、セッションが消えてログイン画面へ移る", async () => {
  const env = await makeEnv();
  const cookie = await sessionCookie();

  // ログイン中は設定が読める
  expect((await app.request("https://app.example/v/.config", { headers: { Cookie: cookie } }, env)).status).toBe(200);

  const out = await app.request("https://app.example/.logout", { headers: { Cookie: cookie } }, env);
  expect(out.status).toBe(302);
  expect(out.headers.get("Location")).toBe("/.auth");
  expect(out.headers.get("Set-Cookie")).toMatch(/^vw_session=;/);

  // 消したあとは、繋がっていない状態の設定が返る（画面は開けるが、ノートは読めない）
  const after = await app.request("https://app.example/v/.config", {}, env);
  expect(after.status).toBe(200);
  const boot = (await after.json()) as { connected: boolean; githubRepo: unknown };
  expect(boot.connected).toBe(false);
  expect(boot.githubRepo).toBeNull();
});

test("ログインしていない端末は、ノートの中身を取れない", async () => {
  const env = await makeEnv();
  const calls = fakeGitHub([]);
  for (const path of ["/v/api/gh/repos/me/notes/git/trees/main", "/v/api/gh/repos/me/notes/commits"]) {
    const res = await app.request(`https://app.example${path}`, {}, env);
    expect(res.status).toBe(401);
  }
  // GitHub には問い合わせていない
  expect(calls.length).toBe(0);
});

test("要望のフォームは、ログインした人の本文を KV に置き、GitHub には送らない", async () => {
  const store = new Map<string, string>();
  const env = { ...(await makeEnv()), APP_KV: fakeKv(store) };
  const calls = fakeGitHub([]);
  const send = (init: RequestInit) => app.request("https://app.example/v/api/feedback", { method: "POST", ...init }, env);
  const json = (body: unknown, cookie?: string) => ({
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

  // ログインしていなければ受けない
  expect((await send(json({ message: "こんにちは" }))).status).toBe(401);
  const cookie = await sessionCookie();
  // 空・長すぎ・JSON 以外は受けない
  expect((await send(json({ message: "   " }, cookie))).status).toBe(400);
  expect((await send(json({ message: "あ".repeat(4001) }, cookie))).status).toBe(400);
  expect((await send({ headers: { Cookie: cookie }, body: "message=x" })).status).toBe(415);
  expect(store.size).toBe(0);

  const res = await send(json({ message: " 検索を速くしてほしい \n" }, cookie));
  expect(res.status).toBe(201);
  const [key, value] = [...store][0]!;
  expect(key).toMatch(/^feedback:\d{4}-\d{2}-\d{2}T[^:]+:[^:]+:[^:]+:[0-9a-f-]{36}$/);
  expect(JSON.parse(value!)).toMatchObject({ message: "検索を速くしてほしい", login: "me" });
  expect(calls).toHaveLength(0);
});

test("管理画面は、管理者にだけ要望を新しい順に見せる", async () => {
  const store = new Map<string, string>();
  const env = { ...(await makeEnv()), APP_KV: fakeKv(store) };
  store.set("feedback:2026-11-10T01:00:00.000Z:a", JSON.stringify({ message: "古い要望", login: "friend", createdAt: "2026-11-10T01:00:00.000Z" }));
  store.set("feedback:2026-11-10T02:00:00.000Z:b", JSON.stringify({ message: "<script>新しい</script>", login: "me", createdAt: "2026-11-10T02:00:00.000Z" }));
  const open = (cookie?: string) =>
    app.request("https://app.example/v/admin", cookie ? { headers: { Cookie: cookie } } : {}, env);

  // ログインしていなければログインへ
  const anonymous = await open();
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.get("Location")).toBe("/.auth");
  // 使えるアカウントでも、管理者でなければ無いことにする
  expect((await open(await sessionCookie("friend"))).status).toBe(404);

  const res = await open(await sessionCookie("me"));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  const html = await res.text();
  expect(html.indexOf("新しい")).toBeLessThan(html.indexOf("古い要望"));
  expect(html).toContain("2026-11-10 11:00 · me");
  // 本文はそのまま HTML にしない
  expect(html).not.toContain("<script>");
});

test("管理画面が読む本文は新しい順に上限まで。dev という名前のログインでも管理者の確認は省かない", async () => {
  const { listFeedback, FEEDBACK_SHOWN } = await import("./admin");
  const store = new Map<string, string>();
  for (let i = 0; i < FEEDBACK_SHOWN + 5; i++) {
    const at = new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString();
    store.set(`feedback:${at}:${i}`, JSON.stringify({ message: `要望${i}`, login: "me", createdAt: at }));
  }
  const kv = fakeKv(store);
  const get = vi.spyOn(kv, "get");
  const { entries, total } = await listFeedback(kv);
  expect(total).toBe(FEEDBACK_SHOWN + 5);
  expect(entries).toHaveLength(FEEDBACK_SHOWN);
  expect(entries[0]!.message).toBe(`要望${FEEDBACK_SHOWN + 4}`);
  expect(get).toHaveBeenCalledTimes(FEEDBACK_SHOWN);

  const env = { ...(await makeEnv()), ALLOWED_LOGINS: "me,dev", APP_KV: kv };
  const res = await app.request("https://app.example/v/admin", { headers: { Cookie: await sessionCookie("dev") } }, env);
  expect(res.status).toBe(404);
});

test("別のタブでリポジトリを切り替えたあと、古いタブからの書き込みは新しいリポジトリに入らない", async () => {
  const env = await makeEnv();
  const cookie = await sessionCookie();
  const calls = fakeGitHub([]);
  for (const path of ["/v/api/gh/commit", "/v/api/gh/move"]) {
    const res = await app.request(
      `https://app.example${path}`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Rootlore-Repo": "me/old" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: "repo" });
  }
  expect(calls).toHaveLength(0);
});
