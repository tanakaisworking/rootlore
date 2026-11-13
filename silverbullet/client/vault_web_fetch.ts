// vault-web: Worker の /api/gh を呼ぶ。アクセストークンが切れていたら、/.auth/refresh で更新して1回だけやり直す。
// Service Worker と画面のどちらからも使う。

type AuthError = "refresh" | "login" | undefined;

async function authError(res: Response): Promise<AuthError> {
  if (res.status !== 401) return undefined;
  const body = (await res.clone().json().catch(() => ({}))) as {
    error?: string;
  };
  return body.error === "refresh" || body.error === "login"
    ? body.error
    : undefined;
}

let localLock: Promise<unknown> = Promise.resolve();

/**
 * refresh token は1回しか使えないので、更新は同時に1つだけ。
 * 画面・Service Worker・別のタブで共有するため Web Locks を使う（使えない環境ではこの中だけで順番にする）
 */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks) return locks.request("vault-web-refresh", fn);
  const run = localLock.then(fn, fn);
  localLock = run.catch(() => undefined);
  return run;
}

/** セッションが切れた。開いている画面をログイン画面へ移す */
function goToLogin() {
  const self = globalThis as any;
  if (typeof self.window !== "undefined") {
    self.location.assign("/.auth");
    return;
  }
  // Service Worker から: 管理している画面をすべて移す
  self.clients
    ?.matchAll({ type: "window" })
    .then((clients: any[]) => {
      for (const client of clients) client.navigate?.("/.auth");
    })
    .catch(() => undefined);
}

/**
 * 書き込み（/commit・/move）に添える、この画面が開いているリポジトリ（owner/repo）。
 * 別のタブでリポジトリを切り替えると、Cookie のセッションは新しいほうを指す。古いタブからの書き込みが
 * 新しいリポジトリに入らないよう、Worker が照合する（worker/index.ts。違えば 412 {error:"repo"}）
 */
export const repoHeader = "X-Rootlore-Repo";

function expectedRepo(path: string): string | undefined {
  if (path !== "/commit" && path !== "/move") return undefined;
  const repo = (globalThis as any).client?.bootConfig?.githubRepo as { owner: string; repo: string } | null | undefined;
  return repo ? `${repo.owner}/${repo.repo}` : undefined;
}

/** apiBase は `<origin>/api/gh` */
export async function githubApiFetch(
  apiBase: string,
  path: string,
  init: RequestInit = {},
  // 画面で直した本文を保存しているときは、ログイン画面へ移らない（移ると、直した本文がなくなる）。呼んだ側が 401 を見て知らせる
  { redirectToLogin = true }: { redirectToLogin?: boolean } = {},
): Promise<Response> {
  const expected = expectedRepo(path);
  if (expected) {
    const headers = new Headers(init.headers);
    headers.set(repoHeader, expected);
    init = { ...init, headers };
  }
  const send = () =>
    fetch(`${apiBase}${path}`, {
      // tree の ETag は呼ぶ側で管理する。変わらないもの（commit）は呼ぶ側で cache を指定する
      cache: "no-store",
      ...init,
      credentials: "same-origin",
    });
  let res = await send();
  let error = await authError(res);
  if (error === "refresh") {
    res = await withRefreshLock(async () => {
      // 待っている間に、別のタブや Service Worker が更新を済ませていることがある
      const retry = await send();
      if ((await authError(retry)) !== "refresh") return retry;
      const refreshed = await fetch(
        apiBase.replace(/\/api\/gh$/, "/.auth/refresh"),
        { method: "POST", credentials: "same-origin" },
      ).catch(() => undefined);
      if (refreshed && (await authError(refreshed)) === "login") {
        return refreshed;
      }
      return send();
    });
    error = await authError(res);
  }
  if (error === "login" && redirectToLogin) goToLogin();
  return res;
}
