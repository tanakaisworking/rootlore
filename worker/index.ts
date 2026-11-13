// Worker の仕事は、画面のファイルを配ることと、GitHub API への中継だけ。
// ノートの本文はここに残さない。
//
// 画面は /v/ の下に置く（LP は根に別の Worker がある）。CLI とデスクトップ版は根の口を使うので、
// 同じ口を根と /v の両方に置く。

import { Hono, type Context } from "hono";
import { auth, clearSession, devToken, readSession, repoFor, tokenFor } from "./auth";
import { handleCommit } from "./commit";
import { adminPage, isAdmin, listFeedback } from "./admin";
import { handleErrors, reportWorkerError } from "./errors";
import { handleFeedback } from "./feedback";
import { handleMove } from "./move";
import type { Env } from "./env";
import { messageFor, messages, pageCsp, pageLang } from "./pages";
import { APP_PREFIX, appPaths } from "./paths";
import { proxyGitHub } from "./proxy";

const app = new Hono<{ Bindings: Env }>();

// ログインの口は根だけ（GitHub App の callback が根を指している）。/v の下からも同じ画面に来られるよう、
// 画面の中のリンクは根を指す（worker/pages.ts の APP_PREFIX）
app.route("/.auth", auth);

// 画面の「Client: Logout」は手元のデータを消したあと /.logout に移る
app.get("/.logout", (c) => {
  clearSession(c);
  return c.redirect("/.auth");
});

/** GitHub に読み書きする口で使う、トークンと開いているリポジトリ。リポジトリを選ぶ前はログインし直し扱い */
async function repoAccess(c: Context<{ Bindings: Env }>) {
  const access = await tokenFor(c);
  if ("error" in access) return access;
  if (!access.repo) return { error: "login" as const };
  return { token: access.token, repo: access.repo };
}

/**
 * 画面が開いているつもりのリポジトリ（X-Rootlore-Repo、client/vault_web_fetch.ts）が、セッションのものと違うか。
 * 別のタブで切り替えたあと、古いタブからの書き込みを新しいリポジトリに入れない（412。409 は版の食い違いに使っている）。
 * 付いていなければ見ない
 */
function otherRepo(c: Context<{ Bindings: Env }>, repo: { owner: string; repo: string }): boolean {
  const expected = c.req.header("X-Rootlore-Repo");
  return expected !== undefined && expected.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase();
}

/** アプリの口。根（CLI・デスクトップ版）と /v（画面）の両方に置く */
function mount(prefix: string) {
  const paths = appPaths(prefix);

  // SilverBullet の画面が起動時に読む設定。サーバーの /.config の代わり。
  // まだ GitHub に繋いでいなくても返す（画面を先に見せて、繋ぐのはアカウントのページから）。
  // そのときは githubRepo を null にして、connected: false を添える。
  // 開くリポジトリは、ログインした人がそれぞれ選んだもの（worker/repos.ts）。選ぶ前も繋いでいない扱い
  app.get(paths.config, async (c) => {
    const repo = await repoFor(c);
    const connected = !!repo;
    return c.json(
      {
        connected,
        // 手元のデータ（IndexedDB）の名前にもなる。リポジトリごとに分かれる
        spaceFolderPath: repo ? `github:${repo.owner}/${repo.repo}` : "github:unknown/none",
        spaceName: repo?.repo ?? "Rootlore",
        shareOwnerId: "",
        indexPage: "ホーム",
        // ブラウザは読み取り専用（製品の選択）。書き込みは CLI から /api/gh/commit で
        readOnly: true,
        logPush: false,
        enableClientEncryption: false,
        accountManaged: false,
        shellBackend: "noop",
        disableServiceWorker: false,
        syncProtocolVersion: 2,
        revisions: "disabled",
        spacePrefixes: [],
        githubRepo: repo,
        // vault の中身で画面を変えさせない。見た目はブラウザで選ぶテーマで変える（予定）
        // space-lua は同梱の標準ライブラリだけ動く（client/vault_web_trust.ts）
        disableSpaceStyle: true,
        disablePlugs: true,
      },
      200,
      { "Cache-Control": "no-cache" },
    );
  });

  // Service Worker が動く前（初回の起動）に画面が読む標準ライブラリ
  app.get(`${paths.fs}/Library/Std/*`, (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(new RegExp(`^${prefix}/\\.fs/`), "/_base_fs/");
    return c.env.ASSETS.fetch(new Request(url, c.req.raw));
  });

  // ノートは Service Worker が GitHub から取る。ここには来ない（来たら Service Worker が動く前）
  app.all(paths.fs, (c) => c.text("Not found", 404));
  app.all(paths.fsAll, (c) => c.text("Not found", 404));
  // 画面がオンラインかを確かめるのに使う。GitHub には問い合わせない
  app.get(paths.ping, (c) => c.json({}, 200, { "Cache-Control": "no-store" }));
  // SilverBullet のサーバーの機能（リアルタイムの通知、ログ送信など）は持たない
  app.all(paths.events, (c) => c.text("Not found", 404));
  app.all(paths.logs, (c) => c.body(null, 204));

  // CLI の書き込み（worker/commit.ts）。GitHub API の中継とは別に、ここで中身を確かめてからコミットする
  app.all(paths.commit, async (c) => {
    const access = await repoAccess(c);
    if ("error" in access) return c.json({ error: access.error }, 401, { "Cache-Control": "no-store" });
    if (otherRepo(c, access.repo)) return c.json({ error: "repo" }, 412, { "Cache-Control": "no-store" });
    const { owner, repo, branch } = access.repo;
    return handleCommit(c.req.raw, access.token, { owner, repo }, branch);
  });

  app.all(paths.move, async (c) => {
    const access = await repoAccess(c);
    if ("error" in access) return c.json({ error: access.error }, 401, { "Cache-Control": "no-store" });
    if (otherRepo(c, access.repo)) return c.json({ error: "repo" }, 412, { "Cache-Control": "no-store" });
    const { owner, repo, branch } = access.repo;
    return handleMove(c.req.raw, access.token, { owner, repo }, branch);
  });

  // 要望のフォーム（worker/feedback.ts）。GitHub には送らず、KV に置く
  app.all(paths.feedback, async (c) => {
    const login = devToken(c) ? "dev" : (await readSession(c))?.login;
    if (!login) return c.json({ error: "login" }, 401, { "Cache-Control": "no-store" });
    return handleFeedback(c.req.raw, login, c.env.APP_KV);
  });

  // エラーの報告（worker/errors.ts）。ログインの前に起きたエラーも受けるので、ログインは求めない
  app.all(paths.errors, (c) => handleErrors(c.req.raw, c.env.SENTRY_APP_DSN, c.env.ERRORS_LIMIT));

  app.all(paths.gh, async (c) => {
    const access = await repoAccess(c);
    // ブラウザは "refresh" なら /.auth/refresh を呼んでやり直し、"login" ならログイン画面へ
    // （リポジトリをまだ選んでいなければ、ログイン画面が選ぶ画面に回す）
    if ("error" in access) return c.json({ error: access.error }, 401, { "Cache-Control": "no-store" });
    const url = new URL(c.req.url);
    const apiPath = url.pathname.slice(`${prefix}/api/gh`.length) + url.search;
    const { owner, repo } = access.repo;
    return proxyGitHub(c.req.raw, apiPath, access.token, { owner, repo });
  });
}

// 根（CLI・デスクトップ版）と /v（画面）
mount("");
mount(APP_PREFIX);

// 管理画面（worker/admin.ts）。根は LP の Worker が持つので、/v の下にだけ置く。
// ログインしていなければログインへ。管理者でなければ、ページがあること自体を見せない
app.get(`${APP_PREFIX}/admin`, async (c) => {
  // 手元の開発用トークン（localhost だけ）のときだけ、管理者の確認を省く
  if (!devToken(c)) {
    const login = (await readSession(c))?.login;
    if (!login) return c.redirect("/.auth");
    if (!isAdmin(c.env, login)) return c.text("Not found", 404);
  }
  const { entries, total } = await listFeedback(c.env.APP_KV);
  return c.html(adminPage(pageLang(c.req.header("Cookie"), c.req.header("Accept-Language")), entries, total), 200, {
    "Content-Security-Policy": pageCsp(),
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  });
});

// 根は LP（別の Worker）が持つ。ここに来たのは、アプリの場所を直接開いたときだけ
app.get("/", (c) => c.redirect(`${APP_PREFIX}/`));

// /v の下からログインを開いても、根の画面に渡す（Cookie の場所と GitHub App の戻り先が根のため）
app.all(`${APP_PREFIX}/.auth`, (c) => c.redirect("/.auth"));
app.all(`${APP_PREFIX}/.auth/*`, (c) => {
  const url = new URL(c.req.url);
  return c.redirect(`/.auth${url.pathname.slice(`${APP_PREFIX}/.auth`.length)}${url.search}`);
});

// 画面のファイルは /v/ の下にだけ置く
app.all(`${APP_PREFIX}/*`, (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.slice(APP_PREFIX.length) || "/";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error(err);
  try {
    c.executionCtx.waitUntil(reportWorkerError(err, c.req.raw, c.env.SENTRY_DSN));
  } catch {
    // executionCtx の無い場（テスト）では送らない
  }
  const lang = pageLang(c.req.header("Cookie"), c.req.header("Accept-Language"));
  return c.html(
    messageFor(lang, messages(lang).serverError),
    500,
    { "Content-Security-Policy": pageCsp(), "Cache-Control": "no-store" },
  );
});

export default app;
