// GitHub App でのログイン。トークンは暗号化した Cookie に入れ、ブラウザの JavaScript には渡さない。
// 手順はログイン（本人の確認）とインストール（リポジトリへのアクセス）を分ける。

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { appManifest, convertManifestCode, loadAppConfig, saveAppConfig, type AppConfig } from "./app_config";
import { exchangeCode, githubHeaders, refreshToken, TokenRejected } from "./github";
import {
  desktopReturnPage,
  installPage,
  loginPage,
  messageFor,
  messages,
  pageCsp,
  pageLang,
  repoPage,
  setupPage,
  type FormTarget,
} from "./pages";
import { APP_PREFIX } from "./paths";
import { findRepo, listInstalledRepos, RepoListRejected, type RepoChoice } from "./repos";
import { seal, unseal, type Session, type SessionRepo } from "./session";
import type { Env } from "./env";

const SESSION_COOKIE = "vw_session";
const STATE_COOKIE = "vw_state";
/**
 * アプリと CLI のログインの戻し先（state・port・challenge）。ふだんは GitHub の認可の合言葉（vw_state）と一緒に運び、
 * ふつうのログインに紛れ込まないようにする。この Cookie は、リポジトリの許可（インストール）をはさむ間だけ使う
 */
const DESKTOP_COOKIE = "vw_desktop";
/**
 * ログインの途中（GitHub の認可は済み、開くリポジトリをまだ選んでいない）。選ぶ画面の間だけ持つ。
 * 中身はセッションと同じく暗号化する。アプリと CLI のログインなら、戻し先も一緒に入れる
 */
const PENDING_COOKIE = "vw_pending";
const PENDING_TTL = 900;
/** 選ぶ画面の「一覧にない」から App を入れに行った印。戻ってきたら、前に選んだものではなく選ぶ画面を出す */
const PICK_COOKIE = "vw_pick";
/** アプリと CLI のログイン: 専用に発行したトークンを、使い捨ての番号で渡す。番号は5分で消える（ブラウザで「開く」を押すまでの時間） */
const DESKTOP_CODE_PREFIX = "desktop-code:";
const DESKTOP_CODE_TTL = 300;
/** アプリが作る合言葉。戻ってきたリンクが、自分が始めたログインのものかをアプリが確かめる */
const DESKTOP_STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** PKCE（RFC 7636）。challenge は verifier の SHA-256 を base64url にしたもの。番号だけ漏れても引き換えられない */
const DESKTOP_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const DESKTOP_VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
/** 期限の少し前から「切れた」と扱い、使っている途中で切れないようにする */
const EXPIRY_MARGIN_MS = 60_000;

type C = Context<{ Bindings: Env }>;

function isLocal(c: C): boolean {
  const { hostname } = new URL(c.req.url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** 手元の開発だけで使うトークン（`gh auth token`）。localhost 以外では使わない */
export function devToken(c: C): string | undefined {
  return c.env.DEV_GITHUB_TOKEN && isLocal(c) ? c.env.DEV_GITHUB_TOKEN : undefined;
}

export async function readSession(c: C): Promise<Session | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const session = await unseal<Session>(raw, c.env.SESSION_SECRET);
  if (!session || session.refreshTokenExpiresAt <= Date.now()) return null;
  // 許可リストから外したアカウントは、ログイン済みでも使えなくする
  if (!allowedLogin(c.env, session.login)) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return null;
  }
  return session;
}

async function writeSession(c: C, session: Session) {
  setCookie(c, SESSION_COOKIE, await seal(session, c.env.SESSION_SECRET), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor((session.refreshTokenExpiresAt - Date.now()) / 1000),
  });
}

/** repo は、ログインはしたがリポジトリをまだ選んでいないとき null */
export type TokenResult = { token: string; repo: SessionRepo | null } | { error: "login" | "refresh" };

/** 手元の開発で開くリポジトリ（DEV_GITHUB_REPO） */
function devRepo(env: Env): SessionRepo | null {
  const [owner, repo, ...rest] = (env.DEV_GITHUB_REPO ?? "").trim().replace(/\/+$/, "").split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo, branch: env.DEV_GITHUB_BRANCH || "main" };
}

/**
 * 開いているリポジトリ（画面の設定 /.config 用）。アクセストークンが切れていても、ログインが続いていれば返す。
 * 切れたトークンは、画面が GitHub に問い合わせたときに /.auth/refresh で更新する（未接続の画面にしない）
 */
export async function repoFor(c: C): Promise<SessionRepo | null> {
  if (devToken(c)) return devRepo(c.env);
  return (await readSession(c))?.repo ?? null;
}

/** /api/gh で使うトークンと、開いているリポジトリ。切れていたら、ブラウザに /.auth/refresh を呼んでもらう */
export async function tokenFor(c: C): Promise<TokenResult> {
  const dev = devToken(c);
  if (dev) return { token: dev, repo: devRepo(c.env) };
  const session = await readSession(c);
  if (!session) return { error: "login" };
  if (session.accessTokenExpiresAt - EXPIRY_MARGIN_MS <= Date.now()) return { error: "refresh" };
  return { token: session.accessToken, repo: session.repo ?? null };
}

/** 画面の言語（設定で選んだ言語の Cookie、なければブラウザの言語） */
export function lang(c: C) {
  return pageLang(c.req.header("Cookie"), c.req.header("Accept-Language"));
}

function html(c: C, body: string, status: 200 | 400 | 403 | 404 = 200, formTo?: FormTarget) {
  return c.html(body, status, {
    "Content-Security-Policy": pageCsp(formTo),
    "Cache-Control": "no-store",
  });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
}

function sameText(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

/** ALLOWED_LOGINS が空なら誰でも。書いてあれば、そのアカウントだけ（セルフホストで自分だけに絞るとき） */
function allowedLogin(env: Env, login: string): boolean {
  const allowed = (env.ALLOWED_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(login.toLowerCase());
}

async function app(c: C): Promise<AppConfig | null> {
  return loadAppConfig(c.env.APP_KV, c.env.SESSION_SECRET);
}

export const auth = new Hono<{ Bindings: Env }>();

// ログイン画面。ログイン済みでリポジトリをまだ選んでいなければ、選ぶ画面へ
auth.get("/", async (c) => {
  if (devToken(c)) return c.redirect(`${APP_PREFIX}/`);
  const session = await readSession(c);
  if (session) return c.redirect(session.repo ? `${APP_PREFIX}/` : "/.auth/repo");
  if (!(await app(c))) {
    return html(c, messageFor(lang(c), messages(lang(c)).notReady));
  }
  return html(c, loginPage(lang(c)));
});

/** GitHub の認可へ送る。アプリと CLI のログインなら、戻し先を合言葉の Cookie に一緒に入れる */
async function startOAuth(c: C, desktop?: Desktop) {
  const config = await app(c);
  if (!config) return c.redirect("/.auth");
  const state = randomToken();
  const cookie = desktop ? [state, encodeDesktop(desktop)].join(".") : state;
  setCookie(c, STATE_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "Lax", path: "/.auth", maxAge: 600 });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", `${new URL(c.req.url).origin}/.auth/callback`);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

// ふつうのログイン。中断したアプリや CLI のログインの残り（vw_desktop）は消す
auth.get("/login", (c) => {
  deleteCookie(c, DESKTOP_COOKIE, { path: "/.auth" });
  deleteCookie(c, PENDING_COOKIE, { path: "/.auth" });
  return startOAuth(c);
});

auth.get("/callback", async (c) => {
  const config = await app(c);
  const code = c.req.query("code");
  const state = c.req.query("state");
  const [expected, ...desktopParts] = (getCookie(c, STATE_COOKIE) ?? "").split(".");
  deleteCookie(c, STATE_COOKIE, { path: "/.auth" });
  if (!config || !code || !state || !expected || !sameText(state, expected)) {
    return html(c, messageFor(lang(c), messages(lang(c)).loginFailed), 400);
  }
  const desktop = desktopParts.length > 0 ? decodeDesktop(desktopParts.join(".")) : null;
  if (desktopParts.length > 0 && !desktop) return html(c, messageFor(lang(c), messages(lang(c)).loginFailed), 400);
  const tokens = await exchangeCode(config.clientId, config.clientSecret, code);
  const user = (await (await fetch("https://api.github.com/user", { headers: githubHeaders(tokens.accessToken) })).json()) as { login?: string };
  if (!user.login || !allowedLogin(c.env, user.login)) {
    return html(c, messageFor(lang(c), messages(lang(c)).notAllowed), 403);
  }
  // インストールをはさんだアプリや CLI のログインを、始めた人とは別のアカウントで仕上げさせない
  if (desktop?.login && desktop.login.toLowerCase() !== user.login.toLowerCase()) {
    return html(c, messageFor(lang(c), messages(lang(c)).loginFailed), 400);
  }
  const session: Session = { login: user.login, ...tokens };
  // ブラウザのログインで、前に別の人がログインしていたら、ここで外す。この先で失敗の画面を返しても、
  // 前の人のセッションのまま進まないように（同じ人なら、前に選んだリポジトリを続けて開くために残す）
  const pick = getCookie(c, PICK_COOKIE) === "1";
  deleteCookie(c, PICK_COOKIE, { path: "/.auth" });
  const prior = desktop ? null : await readSession(c);
  const samePerson = prior?.login.toLowerCase() === user.login.toLowerCase();
  if (prior && !samePerson) deleteCookie(c, SESSION_COOKIE, { path: "/" });
  const repos = await reposOf(c, tokens.accessToken);
  if (!repos) return html(c, messageFor(lang(c), messages(lang(c)).loginFailed), 400);
  if (repos === "busy") return githubBusy(c);
  if (repos.length === 0) {
    // どのリポジトリにも App が入っていない。許可が済んだら /.auth/installed から認可をやり直し、もう一度ここへ来る
    if (desktop) {
      setCookie(c, DESKTOP_COOKIE, encodeDesktop({ ...desktop, login: user.login }), { httpOnly: true, secure: true, sameSite: "Lax", path: "/.auth", maxAge: 900 });
    }
    return c.redirect("/.auth/install");
  }
  // 1つだけならそれを開く。ブラウザで前に選んだものが一覧に残っていれば、それを続けて開く
  // 共有の端末で別の人がログインし直したときは、前の人の選んだリポジトリを使わない。
  // 選ぶ画面から App を入れに行って戻ってきたときも、足したものを選べるよう、選ぶ画面を出す
  const previous = samePerson && !pick ? prior?.repo : undefined;
  const chosen =
    repos.length === 1 ? repos[0] : previous ? findRepo(repos, `${previous.owner}/${previous.repo}`) : undefined;
  if (chosen) return finishLogin(c, { ...session, repo: sessionRepo(chosen) }, desktop);
  // ブラウザのログインなら、前の人（または前の自分）のセッションをここで外す。選ぶ画面を閉じても前のログインが残らない
  if (!desktop) deleteCookie(c, SESSION_COOKIE, { path: "/" });
  await writePending(c, { session, desktop: desktop ?? undefined });
  return c.redirect("/.auth/repo");
});

function sessionRepo(choice: RepoChoice): SessionRepo {
  return { owner: choice.owner, repo: choice.repo, branch: choice.branch };
}

type Pending = { session: Session; desktop?: Desktop };

async function writePending(c: C, pending: Pending) {
  setCookie(c, PENDING_COOKIE, await seal(pending, c.env.SESSION_SECRET), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/.auth",
    maxAge: PENDING_TTL,
  });
}

async function readPending(c: C): Promise<Pending | null> {
  const raw = getCookie(c, PENDING_COOKIE);
  if (!raw) return null;
  const pending = await unseal<Pending>(raw, c.env.SESSION_SECRET);
  if (!pending || pending.session.accessTokenExpiresAt - EXPIRY_MARGIN_MS <= Date.now()) return null;
  if (!allowedLogin(c.env, pending.session.login)) return null;
  return pending;
}

/**
 * リポジトリが決まったログインを仕上げる。ブラウザなら Cookie に入れてアプリへ。
 * アプリと CLI のログインは、ブラウザのログイン（Cookie）を変えずに、専用のトークンとして渡す。
 * refresh token は1回しか使えないので、ブラウザと共有すると片方の更新でもう片方が切れる
 */
async function finishLogin(c: C, session: Session, desktop: Desktop | null | undefined) {
  // 前に中断したログインの途中が残っていたら捨てる（あとで選ぶ画面を開いたときに使われないように）
  deleteCookie(c, PENDING_COOKIE, { path: "/.auth" });
  if (!desktop) {
    await writeSession(c, session);
    return c.redirect(`${APP_PREFIX}/`);
  }
  const handoff = randomToken();
  await c.env.APP_KV.put(
    DESKTOP_CODE_PREFIX + handoff,
    JSON.stringify({ session: await seal(session, c.env.SESSION_SECRET), challenge: desktop.challenge }),
    { expirationTtl: DESKTOP_CODE_TTL },
  );
  const query = `code=${encodeURIComponent(handoff)}&state=${encodeURIComponent(desktop.state)}`;
  if (desktop.port !== undefined) return c.redirect(`http://127.0.0.1:${desktop.port}/callback?${query}`);
  return html(c, desktopReturnPage(lang(c), `rootlore://auth?${query}`));
}

/**
 * login は、App のインストールをはさんで続けるとき（vw_desktop・vw_pending から引き継ぐとき）に、
 * 誰のログインの続きかを覚えておくもの。共有のブラウザで、別の人が続きを仕上げて、そのトークンが
 * 前の人のアプリや CLI に渡らないよう、callback で照合する
 */
type Desktop = { state: string; port?: number; challenge: string; login?: string };

const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

function parseDesktop(state: string, portText: string | undefined, challenge: string): Desktop | null {
  if (!DESKTOP_STATE.test(state) || !DESKTOP_CHALLENGE.test(challenge)) return null;
  if (portText === undefined || portText === "") return { state, challenge };
  const port = Number(portText);
  if (!/^\d{4,5}$/.test(portText) || port < 1024 || port > 65535) return null;
  return { state, port, challenge };
}

function encodeDesktop(desktop: Desktop): string {
  const parts = [desktop.state, desktop.port ?? "", desktop.challenge];
  return (desktop.login ? [...parts, desktop.login] : parts).join(".");
}

function decodeDesktop(text: string): Desktop | null {
  const [state, port, challenge, login, ...rest] = text.split(".");
  if (rest.length > 0 || state === undefined || challenge === undefined) return null;
  const desktop = parseDesktop(state, port, challenge);
  if (!desktop || login === undefined) return desktop;
  return GITHUB_LOGIN.test(login) ? { ...desktop, login } : null;
}

// アプリと CLI のログインの入口。ふだんのブラウザで開く。GitHub の認可を通して専用のトークンを発行し、
// 使い捨ての番号にして戻す（/.auth/callback）。GitHub で許可済みなら、画面はほぼ通り過ぎるだけ。
// 戻し先は、port があれば CLI の手元の受け口（http://127.0.0.1:{port}/callback）、なければアプリ（rootlore://）
auth.get("/desktop", async (c) => {
  const desktop = parseDesktop(c.req.query("state") ?? "", c.req.query("port"), c.req.query("challenge") ?? "");
  if (!desktop) {
    return html(c, messageFor(lang(c), messages(lang(c)).loginFailed), 400);
  }
  if (!(await app(c))) return html(c, messageFor(lang(c), messages(lang(c)).notReady));
  deleteCookie(c, DESKTOP_COOKIE, { path: "/.auth" });
  deleteCookie(c, PENDING_COOKIE, { path: "/.auth" });
  return startOAuth(c, desktop);
});

async function sha256Base64Url(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// アプリと CLI が番号と verifier を出す（POST の JSON。番号を URL に載せず、記録に残さない）。
// 番号は1回だけ。verifier が、ログインを始めたときの challenge と合うときだけ、ログイン状態（Cookie）を渡す
auth.post("/desktop/redeem", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; verifier?: unknown };
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.verifier === "string" ? body.verifier : "";
  if (!/^[A-Za-z0-9]{16,64}$/.test(code) || !DESKTOP_VERIFIER.test(verifier)) {
    return c.json({ error: "login" }, 400);
  }
  const key = DESKTOP_CODE_PREFIX + code;
  const raw = await c.env.APP_KV.get(key);
  if (raw) await c.env.APP_KV.delete(key);
  const stored = raw ? (JSON.parse(raw) as { session?: string; challenge?: string }) : null;
  const matches =
    typeof stored?.challenge === "string" && sameText(await sha256Base64Url(verifier), stored.challenge);
  const session = matches && stored?.session ? await unseal<Session>(stored.session, c.env.SESSION_SECRET) : null;
  if (!session || session.refreshTokenExpiresAt <= Date.now() || !allowedLogin(c.env, session.login)) {
    return c.json({ error: "login" }, 400);
  }
  await writeSession(c, session);
  return c.json({ login: session.login });
});

function installUrl(config: AppConfig): string {
  return `https://github.com/apps/${config.slug}/installations/new`;
}

// リポジトリへのアクセスを許可してもらう画面
auth.get("/install", async (c) => {
  const config = await app(c);
  if (!config) return c.redirect("/.auth");
  return html(c, installPage(lang(c), installUrl(config)));
});

// GitHub App をインストールし終えたとき（App の setup_url）。認可からやり直して、入れたリポジトリを一覧し直す。
// アプリと CLI のログインの途中なら、そのまま番号を渡すところまで進む
// 選ぶ画面の「一覧にない」から来たとき（/.auth/add）は、ログインの途中（vw_pending）の戻し先も引き継ぐ
auth.get("/installed", async (c) => {
  const pending = await readPending(c);
  const desktop =
    decodeDesktop(getCookie(c, DESKTOP_COOKIE) ?? "") ??
    (pending?.desktop ? { ...pending.desktop, login: pending.session.login } : null);
  deleteCookie(c, DESKTOP_COOKIE, { path: "/.auth" });
  deleteCookie(c, PENDING_COOKIE, { path: "/.auth" });
  return startOAuth(c, desktop ?? undefined);
});

// 選ぶ画面の「一覧にない」。App を入れるリポジトリを足しに GitHub へ。戻ってきたら選ぶ画面を出す
auth.get("/add", async (c) => {
  const config = await app(c);
  if (!config) return c.redirect("/.auth");
  setCookie(c, PICK_COOKIE, "1", { httpOnly: true, secure: true, sameSite: "Lax", path: "/.auth", maxAge: PENDING_TTL });
  // ブラウザ起点の流れ。放っておかれたアプリや CLI の戻し先に、戻ってきた先を取られないようにする
  // （途中のログインの戻し先は vw_pending が持っていて、/.auth/installed が引き継ぐ）
  deleteCookie(c, DESKTOP_COOKIE, { path: "/.auth" });
  return c.redirect(installUrl(config));
});

/**
 * 選ぶ画面で使うログイン。ログインの途中（vw_pending）か、ログイン済みのブラウザ（リポジトリを替えるとき）。
 * アカウントのページから来たとき（?switch=1）は、放っておかれたアプリや CLI のログインの途中を捨てて、
 * ブラウザのセッションを使う（途中の分を使うと、選んだ結果がアプリへ渡り、ブラウザは切り替わらない）
 */
async function repoSource(c: C): Promise<{ session: Session; pending?: Pending } | null> {
  if (c.req.query("switch") === "1") {
    deleteCookie(c, PENDING_COOKIE, { path: "/.auth" });
  } else {
    const pending = await readPending(c);
    // 別の人がログインしているブラウザに残った、ブラウザの途中のログインは使わない。
    // アプリと CLI のログインはブラウザのセッションを書き換えないので、誰がログインしていても続ける
    const current = pending && !pending.desktop ? await readSession(c) : null;
    if (pending && (pending.desktop || !current || current.login.toLowerCase() === pending.session.login.toLowerCase())) {
      return { session: pending.session, pending };
    }
  }
  const session = await readSession(c);
  if (!session || session.accessTokenExpiresAt - EXPIRY_MARGIN_MS <= Date.now()) return null;
  return { session };
}

/** null はトークンが使えない（ログインし直す）。GitHub に届かない・混んでいるときは "busy" */
async function reposOf(c: C, token: string): Promise<RepoChoice[] | null | "busy"> {
  try {
    return await listInstalledRepos(token);
  } catch (e) {
    if (e instanceof RepoListRejected) return null;
    console.error(e);
    return "busy";
  }
}

function githubBusy(c: C) {
  return html(c, messageFor(lang(c), messages(lang(c)).githubBusy), 400);
}

// 開くリポジトリを選ぶ画面
auth.get("/repo", async (c) => {
  const config = await app(c);
  const source = await repoSource(c);
  // 途中の情報が切れた、またはトークンの更新が要る。認可をやり直す（GitHub で許可済みなら、ほぼ通り過ぎる）。
  // 切り替えの途中なら、戻ってきたときに前のリポジトリを開き直さず、選ぶ画面を出す
  if (!config || !source) {
    if (c.req.query("switch") === "1") {
      setCookie(c, PICK_COOKIE, "1", { httpOnly: true, secure: true, sameSite: "Lax", path: "/.auth", maxAge: PENDING_TTL });
    }
    return c.redirect("/.auth/login");
  }
  const repos = await reposOf(c, source.session.accessToken);
  if (!repos) {
    if (c.req.query("switch") === "1") {
      setCookie(c, PICK_COOKIE, "1", { httpOnly: true, secure: true, sameSite: "Lax", path: "/.auth", maxAge: PENDING_TTL });
    }
    return c.redirect("/.auth/login");
  }
  if (repos === "busy") return githubBusy(c);
  if (repos.length === 0) {
    // アプリや CLI のログインの途中なら、許可のあとにそこへ戻れるよう、戻し先を写す
    const desktop = source.pending?.desktop;
    if (desktop) {
      const login = source.pending!.session.login;
      setCookie(c, DESKTOP_COOKIE, encodeDesktop({ ...desktop, login }), { httpOnly: true, secure: true, sameSite: "Lax", path: "/.auth", maxAge: 900 });
    } else {
      deleteCookie(c, DESKTOP_COOKIE, { path: "/.auth" });
    }
    return c.redirect("/.auth/install");
  }
  const current = source.pending ? undefined : source.session.repo;
  return html(c, repoPage(lang(c), repos, "/.auth/add", current), 200, "self");
});

auth.post("/repo", async (c) => {
  // よそのページから送らせない（Cookie も SameSite=Lax で、よそからの POST には付かない）
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.text("Forbidden", 403);
  const source = await repoSource(c);
  if (!source) return c.redirect("/.auth/login");
  const form = await c.req.parseBody();
  const name = typeof form.repo === "string" ? form.repo : "";
  const repos = await reposOf(c, source.session.accessToken);
  if (!repos) return c.redirect("/.auth/login");
  if (repos === "busy") return githubBusy(c);
  const chosen = findRepo(repos, name);
  if (!chosen) return c.redirect("/.auth/repo");
  const session: Session = { ...source.session, repo: sessionRepo(chosen) };
  if (source.pending) {
    deleteCookie(c, PENDING_COOKIE, { path: "/.auth" });
    return finishLogin(c, session, source.pending.desktop);
  }
  await writeSession(c, session);
  return c.redirect(`${APP_PREFIX}/`);
});

// 画面の起動時に、ログインしているかを確かめる
auth.get("/me", async (c) => {
  if (devToken(c)) return c.json({ login: "dev" });
  const session = await readSession(c);
  return session ? c.json({ login: session.login }) : c.json({ error: "login" }, 401);
});

// アカウントのページ: ログインしている本人の表示名と GitHub のプロフィールの URL。
// 起動のたびに呼ぶ /me を遅くしないよう分ける。トークンの更新が要るときは返さない（画面はログイン名だけで出す）
auth.get("/profile", async (c) => {
  const access = await tokenFor(c);
  if ("error" in access) return c.json({ error: access.error }, 401, { "Cache-Control": "no-store" });
  const res = await fetch("https://api.github.com/user", { headers: githubHeaders(access.token) });
  if (!res.ok) return c.json({ error: "github" }, 502, { "Cache-Control": "no-store" });
  const user = (await res.json()) as { login?: string; name?: string | null; html_url?: string };
  return c.json(
    { login: user.login ?? "", name: user.name ?? null, htmlUrl: user.html_url ?? null },
    200,
    { "Cache-Control": "private, no-store" },
  );
});

// アカウントのページ: ログインしている本人の GitHub のアイコン画像。
// 画面の CSP は外の画像を読ませないので、ここで取って同じサイトの画像として返す（本人の分だけ）
auth.get("/avatar", async (c) => {
  const session = await readSession(c);
  if (!session) return c.body(null, 404);
  const res = await fetch(`https://github.com/${encodeURIComponent(session.login)}.png?size=160`, {
    headers: { "User-Agent": "rootlore" },
  });
  const type = res.headers.get("Content-Type") ?? "";
  if (!res.ok || !type.startsWith("image/")) return c.body(null, 404);
  return new Response(res.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// アクセストークンの更新。refresh token は1回しか使えないので、ブラウザ側で同時に1つだけ呼ぶ
// （client/vault_web_fetch.ts が Web Locks でタブと Service Worker をまたいで1つにしている）
auth.post("/refresh", async (c) => {
  if (devToken(c)) return c.body(null, 204);
  const config = await app(c);
  const session = await readSession(c);
  if (!config || !session) return c.json({ error: "login" }, 401);
  try {
    const tokens = await refreshToken(config.clientId, config.clientSecret, session.refreshToken);
    await writeSession(c, { ...session, ...tokens });
    return c.body(null, 204);
  } catch (e) {
    if (e instanceof TokenRejected) {
      // refresh token が使えない（取り消された、など）。ログインし直してもらう
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ error: "login" }, 401);
    }
    // GitHub に届かなかったなど。Cookie は残して、次の呼び出しでもう一度試す
    console.error(e);
    return c.json({ error: "refresh" }, 401);
  }
});

auth.post("/logout", (c) => {
  clearSession(c);
  return c.body(null, 204);
});

/** ログアウト。ログインの途中（選ぶ画面、アプリと CLI の戻し先）も一緒に消す（共有の端末で次の人に残さない） */
export function clearSession(c: C) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, PENDING_COOKIE, { path: "/.auth" });
  deleteCookie(c, DESKTOP_COOKIE, { path: "/.auth" });
  deleteCookie(c, PICK_COOKIE, { path: "/.auth" });
}

// 初期設定: GitHub App を manifest で作る。SETUP_TOKEN を知っている人だけ、App がまだないときだけ
auth.get("/setup", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!c.env.SETUP_TOKEN || !sameText(token, c.env.SETUP_TOKEN) || (await app(c))) return c.notFound();
  const origin = new URL(c.req.url).origin;
  return html(c, setupPage(lang(c), appManifest(origin, new URL(origin).hostname), token), 200, "github");
});

auth.get("/setup/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  if (!code || !c.env.SETUP_TOKEN || !sameText(state, c.env.SETUP_TOKEN) || (await app(c))) return c.notFound();
  const config = await convertManifestCode(code);
  await saveAppConfig(c.env.APP_KV, c.env.SESSION_SECRET, config);
  return html(c, messageFor(lang(c), messages(lang(c)).appCreated));
});
