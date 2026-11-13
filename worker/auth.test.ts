import { expect, test, vi } from "vitest";
import app from "./index";
import { seal, unseal, type Session } from "./session";
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
const env = {
  ALLOWED_LOGINS: "me",
  SESSION_SECRET: secret,
} as Env;

async function cookieFor(login: string, repo?: Session["repo"]) {
  const session: Session = {
    login,
    repo,
    accessToken: "t",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshToken: "r",
    refreshTokenExpiresAt: Date.now() + 86_400_000,
  };
  return `vw_session=${await seal(session, secret)}`;
}

test("a session keeps working while its login is allowed", async () => {
  const res = await app.request("https://app.example/.auth/me", { headers: { Cookie: await cookieFor("me") } }, env);
  expect(await res.json()).toEqual({ login: "me" });
});

test("a session stops working once its login is removed from ALLOWED_LOGINS", async () => {
  const res = await app.request("https://app.example/.auth/me", { headers: { Cookie: await cookieFor("someone") } }, env);
  expect(res.status).toBe(401);
  expect(res.headers.get("Set-Cookie")).toMatch(/^vw_session=;/);
});

test("/.logout clears the session and goes to the login page", async () => {
  const res = await app.request("https://app.example/.logout", { headers: { Cookie: await cookieFor("me") } }, env);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/.auth");
  expect(res.headers.get("Set-Cookie")).toMatch(/^vw_session=;/);
});

test("/.auth/avatar returns only the signed-in user's own GitHub picture", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    return new Response("png", { headers: { "Content-Type": "image/png" } });
  });
  try {
    const res = await app.request("https://app.example/.auth/avatar?login=other", { headers: { Cookie: await cookieFor("me") } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(calls).toEqual(["https://github.com/me.png?size=160"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("/.auth/avatar and /.auth/profile need a session", async () => {
  expect((await app.request("https://app.example/.auth/avatar", {}, env)).status).toBe(404);
  expect((await app.request("https://app.example/.auth/profile", {}, env)).status).toBe(401);
});

test("/.auth/profile returns the display name with the session's token", async () => {
  const auth: (string | null)[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("Authorization"));
    return Response.json({ login: "me", name: "Me Myself", html_url: "https://github.com/me", email: "x@example.com" });
  });
  try {
    const res = await app.request("https://app.example/.auth/profile", { headers: { Cookie: await cookieFor("me") } }, env);
    expect(await res.json()).toEqual({ login: "me", name: "Me Myself", htmlUrl: "https://github.com/me" });
    expect(auth).toEqual(["Bearer t"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

function memoryKv() {
  const map = new Map<string, string>();
  return {
    map,
    kv: {
      get: async (k: string) => map.get(k) ?? null,
      put: async (k: string, v: string) => void map.set(k, v),
      delete: async (k: string) => void map.delete(k),
    } as unknown as KVNamespace,
  };
}

const appState = "s".repeat(24);
const verifier = "v".repeat(43);
// verifier の SHA-256 を base64url にしたもの
async function challengeOf(v: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function desktopEnv() {
  const { kv, map } = memoryKv();
  const e = { ...env, APP_KV: kv };
  await saveAppConfig(kv, secret, { id: 1, slug: "rootlore-test", clientId: "cid", clientSecret: "csec", htmlUrl: "" });
  return { e, map };
}

/** GitHub の代わり。repos は App を入れたリポジトリ（空なら、どこにも入っていない） */
function stubGitHub(repos: string[] = ["me/notes"], login = "me") {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "new-at", expires_in: 28800, refresh_token: "new-rt", refresh_token_expires_in: 15897600 });
    }
    if (u === "https://api.github.com/user") return Response.json({ login });
    if (u.startsWith("https://api.github.com/user/installations?")) {
      return Response.json({ installations: repos.length ? [{ id: 7 }] : [] });
    }
    if (u.startsWith("https://api.github.com/user/installations/7/repositories?")) {
      return Response.json({
        repositories: repos.map((full) => {
          const [owner, name] = full.split("/");
          return { name, owner: { login: owner }, default_branch: name === "wiki" ? "trunk" : "main", private: true };
        }),
      });
    }
    throw new Error("unexpected fetch " + u);
  });
}

function cookieValue(res: Response, name: string) {
  return new RegExp("(?:^|, )" + name + "=([^;]*)").exec(res.headers.get("Set-Cookie") ?? "")?.[1];
}

async function startDesktop(e: Env, port = "49152") {
  const challenge = await challengeOf(verifier);
  const res = await app.request("https://app.example/.auth/desktop?state=" + appState + "&port=" + port + "&challenge=" + challenge, {}, e);
  const stateCookie = decodeURIComponent(cookieValue(res, "vw_state") ?? "");
  return { res, stateCookie, oauthState: stateCookie.split(".")[0] };
}

async function callback(e: Env, stateCookie: string, cookies = "") {
  const oauthState = stateCookie.split(".")[0];
  return app.request(
    "https://app.example/.auth/callback?code=gh&state=" + oauthState,
    { headers: { Cookie: "vw_state=" + encodeURIComponent(stateCookie) + (cookies ? "; " + cookies : "") } },
    e,
  );
}

async function plainLogin(e: Env) {
  const res = await app.request("https://app.example/.auth/login", {}, e);
  return decodeURIComponent(cookieValue(res, "vw_state") ?? "");
}

test("/.auth/desktop refuses an odd state, port or challenge", async () => {
  const { e } = await desktopEnv();
  const challenge = await challengeOf(verifier);
  for (const q of [
    "state=x&challenge=" + challenge,
    "state=" + appState + "&challenge=short",
    "state=" + appState,
    ...["80", "70000", "12ab", "49152/evil"].map((p) => "state=" + appState + "&port=" + p + "&challenge=" + challenge),
  ]) {
    expect((await app.request("https://app.example/.auth/desktop?" + q, {}, e)).status).toBe(400);
  }
});

test("the CLI login gets its own tokens through GitHub, without touching the browser's session", async () => {
  const { e, map } = await desktopEnv();
  const { res, stateCookie } = await startDesktop(e);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  stubGitHub();
  try {
    const back = await callback(e, stateCookie, await cookieFor("me"));
    expect(back.status).toBe(302);
    const loc = back.headers.get("Location")!;
    expect(loc).toMatch(new RegExp("^http://127\\.0\\.0\\.1:49152/callback\\?code=[A-Za-z0-9]+&state=" + appState + "$"));
    // ブラウザの Cookie は書き換えない
    expect(cookieValue(back, "vw_session")).toBeUndefined();
    expect(map.size).toBe(2); // App の設定と番号

    const code = /code=([A-Za-z0-9]+)/.exec(loc)![1];
    const redeem = (v: string) =>
      app.request("https://app.example/.auth/desktop/redeem", { method: "POST", body: JSON.stringify({ code, verifier: v }) }, e);
    expect((await redeem("w".repeat(43))).status).toBe(400); // 番号だけでは引き換えられない（その時点で番号も消える）
  } finally {
    vi.unstubAllGlobals();
  }
});

test("the right verifier redeems the code once and gets a session made from the new tokens", async () => {
  const { e } = await desktopEnv();
  const { stateCookie } = await startDesktop(e);
  stubGitHub();
  try {
    const back = await callback(e, stateCookie);
    const code = /code=([A-Za-z0-9]+)/.exec(back.headers.get("Location")!)![1];
    const redeem = () =>
      app.request("https://app.example/.auth/desktop/redeem", { method: "POST", body: JSON.stringify({ code, verifier }) }, e);
    const first = await redeem();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ login: "me" });
    const sealed = cookieValue(first, "vw_session")!;
    const session = await unseal<Session>(decodeURIComponent(sealed), secret);
    expect(session?.refreshToken).toBe("new-rt");
    expect(session?.repo).toEqual({ owner: "me", repo: "notes", branch: "main" });
    expect((await redeem()).status).toBe(400);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a first-time repository install in the middle still ends at the CLI", async () => {
  const { e } = await desktopEnv();
  const { stateCookie } = await startDesktop(e);
  stubGitHub([]);
  let desktop: string | undefined;
  try {
    const back = await callback(e, stateCookie);
    expect(back.headers.get("Location")).toBe("/.auth/install");
    desktop = cookieValue(back, "vw_desktop");
    expect(desktop).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
  const installed = await app.request("https://app.example/.auth/installed", { headers: { Cookie: "vw_desktop=" + desktop } }, e);
  expect(installed.headers.get("Location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  const again = decodeURIComponent(cookieValue(installed, "vw_state") ?? "");
  stubGitHub();
  try {
    const done = await callback(e, again);
    expect(done.headers.get("Location")).toMatch(/^http:\/\/127\.0\.0\.1:49152\/callback\?code=/);
  } finally {
    vi.unstubAllGlobals();
  }
  // ふつうのログインでも、認可をやり直して、入れたリポジトリを一覧し直す
  const plain = await app.request("https://app.example/.auth/installed", {}, e);
  expect(plain.headers.get("Location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
});

test("an abandoned CLI login does not take over a later normal browser login", async () => {
  const { e } = await desktopEnv();
  await startDesktop(e); // 中断した（ブラウザには残りの Cookie があるとする）
  const leftover = "vw_desktop=" + encodeURIComponent(appState + ".49152." + (await challengeOf(verifier)));
  const stateCookie = await plainLogin(e);
  expect(stateCookie).not.toContain(".");
  stubGitHub();
  try {
    const back = await callback(e, stateCookie, leftover);
    expect(back.headers.get("Location")).toBe("/v/");
    expect(cookieValue(back, "vw_session")).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("the browser login still sets the browser's session and goes to the first page", async () => {
  const { e } = await desktopEnv();
  const stateCookie = await plainLogin(e);
  stubGitHub();
  try {
    const back = await callback(e, stateCookie);
    expect(back.headers.get("Location")).toBe("/v/");
    expect(cookieValue(back, "vw_session")).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});

async function sessionOf(res: Response) {
  return unseal<Session>(decodeURIComponent(cookieValue(res, "vw_session") ?? ""), secret);
}

test("with one installed repository, the browser login opens it right away", async () => {
  const { e } = await desktopEnv();
  stubGitHub(["me/wiki"]);
  try {
    const back = await callback(e, await plainLogin(e));
    expect(back.headers.get("Location")).toBe("/v/");
    expect((await sessionOf(back))?.repo).toEqual({ owner: "me", repo: "wiki", branch: "trunk" });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("with several repositories, the login asks which one to open, and only lists installed ones", async () => {
  const { e } = await desktopEnv();
  stubGitHub(["me/notes", "me/wiki"]);
  try {
    const back = await callback(e, await plainLogin(e));
    expect(back.headers.get("Location")).toBe("/.auth/repo");
    // 選び終わるまでは、前のログインも残さない
    expect(cookieValue(back, "vw_session")).toBe("");
    const pending = "vw_pending=" + cookieValue(back, "vw_pending");

    const picker = await app.request("https://app.example/.auth/repo", { headers: { Cookie: pending } }, e);
    expect(picker.status).toBe(200);
    const page = await picker.text();
    expect(page).toContain('value="me/notes"');
    expect(page).toContain('value="me/wiki"');
    expect(picker.headers.get("Content-Security-Policy")).toContain("form-action 'self'");

    const choose = (repo: string, origin = "https://app.example") =>
      app.request(
        "https://app.example/.auth/repo",
        {
          method: "POST",
          headers: { Cookie: pending, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
          body: "repo=" + encodeURIComponent(repo),
        },
        e,
      );
    // 入れていないリポジトリは選べない
    const other = await choose("someone/else");
    expect(other.headers.get("Location")).toBe("/.auth/repo");
    expect(cookieValue(other, "vw_session")).toBeUndefined();
    // よそのページからは送れない
    expect((await choose("me/wiki", "https://evil.example")).status).toBe(403);

    const done = await choose("me/wiki");
    expect(done.headers.get("Location")).toBe("/v/");
    expect((await sessionOf(done))?.repo).toEqual({ owner: "me", repo: "wiki", branch: "trunk" });
    expect(cookieValue(done, "vw_pending")).toBe("");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a signed-in browser can switch to another installed repository", async () => {
  const { e } = await desktopEnv();
  const cookie = await cookieFor("me", { owner: "me", repo: "notes", branch: "main" });
  stubGitHub(["me/notes", "me/wiki"]);
  try {
    const picker = await app.request("https://app.example/.auth/repo", { headers: { Cookie: cookie } }, e);
    expect(await picker.text()).toMatch(/value="me\/notes"><span class="repo-name">.*Open now/);
    const done = await app.request(
      "https://app.example/.auth/repo",
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "repo=me%2Fwiki" },
      e,
    );
    expect(done.headers.get("Location")).toBe("/v/");
    const session = await sessionOf(done);
    expect(session?.repo?.repo).toBe("wiki");
    expect(session?.refreshToken).toBe("r");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a CLI login with several repositories asks in the browser, then still ends at the CLI", async () => {
  const { e } = await desktopEnv();
  const { stateCookie } = await startDesktop(e);
  stubGitHub(["me/notes", "me/wiki"]);
  try {
    const back = await callback(e, stateCookie);
    expect(back.headers.get("Location")).toBe("/.auth/repo");
    const pending = "vw_pending=" + cookieValue(back, "vw_pending");
    const done = await app.request(
      "https://app.example/.auth/repo",
      { method: "POST", headers: { Cookie: pending, "Content-Type": "application/x-www-form-urlencoded" }, body: "repo=me%2Fwiki" },
      e,
    );
    expect(done.headers.get("Location")).toMatch(/^http:\/\/127\.0\.0\.1:49152\/callback\?code=/);
    expect(cookieValue(done, "vw_session")).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("the repository chooser without a login goes back to sign-in", async () => {
  const { e } = await desktopEnv();
  const res = await app.request("https://app.example/.auth/repo", {}, e);
  expect(res.headers.get("Location")).toBe("/.auth/login");
});

test("a session without a repository is sent to the chooser, and the app treats it as not connected", async () => {
  const { e } = await desktopEnv();
  const cookie = await cookieFor("me");
  expect((await app.request("https://app.example/.auth", { headers: { Cookie: cookie } }, e)).headers.get("Location")).toBe(
    "/.auth/repo",
  );
  const config = await (await app.request("https://app.example/v/.config", { headers: { Cookie: cookie } }, e)).json();
  expect(config).toMatchObject({ connected: false, githubRepo: null, spaceFolderPath: "github:unknown/none" });
  const gh = await app.request("https://app.example/v/api/gh/repos/me/notes/commits", { headers: { Cookie: cookie } }, e);
  expect(gh.status).toBe(401);
  expect(await gh.json()).toEqual({ error: "login" });
});

test("without ALLOWED_LOGINS, anyone can sign in", async () => {
  const { e } = await desktopEnv();
  const open = { ...e, ALLOWED_LOGINS: undefined };
  stubGitHub(["stranger/notes"], "stranger");
  try {
    const back = await callback(open, await plainLogin(open));
    expect(back.headers.get("Location")).toBe("/v/");
    expect((await sessionOf(back))?.login).toBe("stranger");
  } finally {
    vi.unstubAllGlobals();
  }
  // ALLOWED_LOGINS があれば、そのアカウントだけ
  stubGitHub(["stranger/notes"], "stranger");
  try {
    expect((await callback(e, await plainLogin(e))).status).toBe(403);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("refreshing the token keeps the chosen repository", async () => {
  const { e } = await desktopEnv();
  const cookie = await cookieFor("me", { owner: "me", repo: "wiki", branch: "trunk" });
  stubGitHub();
  try {
    const res = await app.request("https://app.example/.auth/refresh", { method: "POST", headers: { Cookie: cookie } }, e);
    expect(res.status).toBe(204);
    const session = await sessionOf(res);
    expect(session?.accessToken).toBe("new-at");
    expect(session?.repo).toEqual({ owner: "me", repo: "wiki", branch: "trunk" });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("switching from the account page ignores an abandoned CLI login and switches the browser", async () => {
  const { e } = await desktopEnv();
  const { stateCookie } = await startDesktop(e);
  stubGitHub(["me/notes", "me/wiki"]);
  try {
    const back = await callback(e, stateCookie);
    const pending = "vw_pending=" + cookieValue(back, "vw_pending");
    const cookie = (await cookieFor("me", { owner: "me", repo: "notes", branch: "main" })) + "; " + pending;
    const picker = await app.request("https://app.example/.auth/repo?switch=1", { headers: { Cookie: cookie } }, e);
    expect(await picker.text()).toContain("Open now");
    expect(cookieValue(picker, "vw_pending")).toBe("");
    // 画面は vw_pending を消したので、次の送信にはセッションだけが付く
    const done = await app.request(
      "https://app.example/.auth/repo",
      { method: "POST", headers: { Cookie: await cookieFor("me", { owner: "me", repo: "notes", branch: "main" }), "Content-Type": "application/x-www-form-urlencoded" }, body: "repo=me%2Fwiki" },
      e,
    );
    expect(done.headers.get("Location")).toBe("/v/");
    expect((await sessionOf(done))?.repo?.repo).toBe("wiki");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("another person signing in on the same browser does not inherit the previous person's repository", async () => {
  const { e } = await desktopEnv();
  const open = { ...e, ALLOWED_LOGINS: undefined };
  const theirs = await cookieFor("me", { owner: "org", repo: "shared", branch: "main" });
  stubGitHub(["org/shared", "other/notes"], "other");
  try {
    const back = await callback(open, await plainLogin(open), theirs);
    expect(back.headers.get("Location")).toBe("/.auth/repo");
  } finally {
    vi.unstubAllGlobals();
  }
  // 同じ人なら、前に選んだものを続けて開く
  stubGitHub(["org/shared", "me/notes"], "me");
  try {
    const back = await callback(open, await plainLogin(open), theirs);
    expect(back.headers.get("Location")).toBe("/v/");
    expect((await sessionOf(back))?.repo?.repo).toBe("shared");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("if the App is removed while choosing during a CLI login, installing again still ends at the CLI", async () => {
  const { e } = await desktopEnv();
  const { stateCookie } = await startDesktop(e);
  stubGitHub(["me/notes", "me/wiki"]);
  let pending = "";
  try {
    pending = "vw_pending=" + cookieValue(await callback(e, stateCookie), "vw_pending");
  } finally {
    vi.unstubAllGlobals();
  }
  stubGitHub([]);
  try {
    const res = await app.request("https://app.example/.auth/repo", { headers: { Cookie: pending } }, e);
    expect(res.headers.get("Location")).toBe("/.auth/install");
    expect(cookieValue(res, "vw_desktop")).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("an expired access token still opens the chosen repository; the token is refreshed on the next GitHub call", async () => {
  const { e } = await desktopEnv();
  const session: Session = {
    login: "me",
    repo: { owner: "me", repo: "notes", branch: "main" },
    accessToken: "old",
    accessTokenExpiresAt: Date.now() - 1000,
    refreshToken: "r",
    refreshTokenExpiresAt: Date.now() + 86_400_000,
  };
  const cookie = `vw_session=${await seal(session, secret)}`;
  const config = await (await app.request("https://app.example/v/.config", { headers: { Cookie: cookie } }, e)).json();
  expect(config).toMatchObject({ connected: true, githubRepo: { owner: "me", repo: "notes", branch: "main" } });
  const gh = await app.request("https://app.example/v/api/gh/repos/me/notes/commits", { headers: { Cookie: cookie } }, e);
  expect(await gh.json()).toEqual({ error: "refresh" });
});

test("adding a repository from the chooser during a CLI login still ends at the CLI", async () => {
  const { e } = await desktopEnv();
  const { stateCookie } = await startDesktop(e);
  stubGitHub(["me/notes", "me/wiki"]);
  let pending = "";
  try {
    pending = "vw_pending=" + cookieValue(await callback(e, stateCookie), "vw_pending");
  } finally {
    vi.unstubAllGlobals();
  }
  const add = await app.request("https://app.example/.auth/add", { headers: { Cookie: pending } }, e);
  expect(add.headers.get("Location")).toBe("https://github.com/apps/rootlore-test/installations/new");
  const pick = "vw_pick=" + cookieValue(add, "vw_pick");
  const installed = await app.request("https://app.example/.auth/installed", { headers: { Cookie: `${pending}; ${pick}` } }, e);
  const again = decodeURIComponent(cookieValue(installed, "vw_state") ?? "");
  expect(again).toContain("."); // 戻し先を合言葉と一緒に運ぶ
  stubGitHub(["me/notes", "me/wiki", "me/journal"]);
  try {
    const back = await callback(e, again, pick);
    expect(back.headers.get("Location")).toBe("/.auth/repo");
    const pending2 = "vw_pending=" + cookieValue(back, "vw_pending");
    const done = await app.request(
      "https://app.example/.auth/repo",
      { method: "POST", headers: { Cookie: pending2, "Content-Type": "application/x-www-form-urlencoded" }, body: "repo=me%2Fjournal" },
      e,
    );
    expect(done.headers.get("Location")).toMatch(/^http:\/\/127\.0\.0\.1:49152\/callback\?code=/);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("coming back from adding a repository shows the chooser instead of reopening the previous one", async () => {
  const { e } = await desktopEnv();
  const cookie = await cookieFor("me", { owner: "me", repo: "notes", branch: "main" });
  stubGitHub(["me/notes", "me/wiki"]);
  try {
    const back = await callback(e, await plainLogin(e), `${cookie}; vw_pick=1`);
    expect(back.headers.get("Location")).toBe("/.auth/repo");
    expect(cookieValue(back, "vw_pick")).toBe("");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("signing out also drops an unfinished login, so the next person can't finish it", async () => {
  const { e } = await desktopEnv();
  const res = await app.request("https://app.example/.logout", { headers: { Cookie: await cookieFor("me") } }, e);
  const cookies = res.headers.get("Set-Cookie") ?? "";
  for (const name of ["vw_session", "vw_pending", "vw_desktop", "vw_pick"]) expect(cookies).toContain(`${name}=;`);
});

test("an unfinished login of an account removed from ALLOWED_LOGINS can't be finished", async () => {
  const { e } = await desktopEnv();
  const open = { ...e, ALLOWED_LOGINS: undefined };
  stubGitHub(["x/a", "x/b"], "someone");
  try {
    const back = await callback(open, await plainLogin(open));
    const pending = "vw_pending=" + cookieValue(back, "vw_pending");
    // e は ALLOWED_LOGINS = "me"
    const res = await app.request("https://app.example/.auth/repo", { headers: { Cookie: pending } }, e);
    expect(res.headers.get("Location")).toBe("/.auth/login");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("when GitHub can't list repositories, the login says to try again instead of failing", async () => {
  const { e } = await desktopEnv();
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "a", expires_in: 28800, refresh_token: "r", refresh_token_expires_in: 15897600 });
    }
    if (u === "https://api.github.com/user") return Response.json({ login: "me" });
    return new Response("rate limited", { status: 403 });
  });
  try {
    const back = await callback(e, await plainLogin(e));
    expect(back.status).toBe(400);
    expect(await back.text()).toContain("GitHub is busy");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("switching with an expired access token signs in again and then shows the chooser", async () => {
  const { e } = await desktopEnv();
  const session: Session = {
    login: "me",
    repo: { owner: "me", repo: "notes", branch: "main" },
    accessToken: "old",
    accessTokenExpiresAt: Date.now() - 1000,
    refreshToken: "r",
    refreshTokenExpiresAt: Date.now() + 86_400_000,
  };
  const cookie = `vw_session=${await seal(session, secret)}`;
  const res = await app.request("https://app.example/.auth/repo?switch=1", { headers: { Cookie: cookie } }, e);
  expect(res.headers.get("Location")).toBe("/.auth/login");
  expect(cookieValue(res, "vw_pick")).toBe("1");
});

test("someone else's unfinished login left in the browser is not used by the signed-in person", async () => {
  const { e } = await desktopEnv();
  const open = { ...e, ALLOWED_LOGINS: undefined };
  const { stateCookie } = await startDesktop(open);
  stubGitHub(["a/notes", "a/wiki"], "alice");
  let pending = "";
  try {
    pending = "vw_pending=" + cookieValue(await callback(open, stateCookie), "vw_pending");
  } finally {
    vi.unstubAllGlobals();
  }
  const bob = await cookieFor("bob", { owner: "b", repo: "notes", branch: "main" });
  stubGitHub(["b/notes", "b/wiki"], "bob");
  try {
    const picker = await app.request("https://app.example/.auth/repo", { headers: { Cookie: `${bob}; ${pending}` } }, open);
    const page = await picker.text();
    expect(page).toContain('value="b/wiki"');
    expect(page).not.toContain('value="a/wiki"');
  } finally {
    vi.unstubAllGlobals();
  }
});

test("someone else can't finish another person's CLI login after installing the App in the same browser", async () => {
  const { e } = await desktopEnv();
  const open = { ...e, ALLOWED_LOGINS: undefined };
  const { stateCookie } = await startDesktop(open);
  stubGitHub(["a/notes", "a/wiki"], "alice");
  let pending = "";
  try {
    pending = "vw_pending=" + cookieValue(await callback(open, stateCookie), "vw_pending");
  } finally {
    vi.unstubAllGlobals();
  }
  // Bob が同じブラウザで App を入れて戻ってくる
  const installed = await app.request("https://app.example/.auth/installed", { headers: { Cookie: pending } }, open);
  const again = decodeURIComponent(cookieValue(installed, "vw_state") ?? "");
  stubGitHub(["b/notes"], "bob");
  try {
    const back = await callback(open, again);
    expect(back.status).toBe(400);
    expect(back.headers.get("Location")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
  // Alice 本人なら CLI まで届く
  stubGitHub(["a/notes"], "alice");
  try {
    const back = await callback(open, again);
    expect(back.headers.get("Location")).toMatch(/^http:\/\/127\.0\.0\.1:49152\/callback\?code=/);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a failed sign-in by someone else does not leave the previous person signed in", async () => {
  const { e } = await desktopEnv();
  const open = { ...e, ALLOWED_LOGINS: undefined };
  const alice = await cookieFor("alice", { owner: "a", repo: "notes", branch: "main" });
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "b", expires_in: 28800, refresh_token: "r", refresh_token_expires_in: 15897600 });
    }
    if (u === "https://api.github.com/user") return Response.json({ login: "bob" });
    return new Response("busy", { status: 503 });
  });
  try {
    const back = await callback(open, await plainLogin(open), alice);
    expect(back.status).toBe(400);
    expect(cookieValue(back, "vw_session")).toBe("");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a CLI login continues even when someone else is signed in to the browser", async () => {
  const { e } = await desktopEnv();
  const open = { ...e, ALLOWED_LOGINS: undefined };
  const { stateCookie } = await startDesktop(open);
  stubGitHub(["b/notes", "b/wiki"], "bob");
  let pending = "";
  try {
    pending = "vw_pending=" + cookieValue(await callback(open, stateCookie), "vw_pending");
  } finally {
    vi.unstubAllGlobals();
  }
  const alice = await cookieFor("alice", { owner: "a", repo: "notes", branch: "main" });
  stubGitHub(["b/notes", "b/wiki"], "bob");
  try {
    const done = await app.request(
      "https://app.example/.auth/repo",
      { method: "POST", headers: { Cookie: `${alice}; ${pending}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "repo=b%2Fwiki" },
      open,
    );
    expect(done.headers.get("Location")).toMatch(/^http:\/\/127\.0\.0\.1:49152\/callback\?code=/);
    expect(cookieValue(done, "vw_session")).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});
