import type { Session } from "./session";

const API = "https://api.github.com";

export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rootlore",
  };
}

type TokenResponse =
  | {
      access_token: string;
      expires_in: number;
      refresh_token: string;
      refresh_token_expires_in: number;
    }
  | { error: string; error_description?: string };

/** GitHub がトークンの発行・更新を断った（refresh token が使えない、など）。一時的な失敗とは分ける */
export class TokenRejected extends Error {
  constructor(readonly code: string) {
    super(`GitHub token error: ${code}`);
  }
}

/** GitHub App のユーザートークンを発行・更新する。code か refresh_token のどちらかを渡す。 */
async function requestToken(
  params: Record<string, string>,
): Promise<Omit<Session, "login">> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "rootlore" },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as TokenResponse;
  if ("error" in body) throw new TokenRejected(body.error);
  if (!body.refresh_token) {
    // 期限なしトークンだと更新の仕組みが前提とずれる。App 設定の確認を促す。
    throw new Error("GitHub Appの「Expire user authorization tokens」を有効にしてください");
  }
  const now = Date.now();
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: now + body.expires_in * 1000,
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: now + body.refresh_token_expires_in * 1000,
  };
}

export function exchangeCode(clientId: string, clientSecret: string, code: string) {
  return requestToken({ client_id: clientId, client_secret: clientSecret, code });
}

export function refreshToken(clientId: string, clientSecret: string, token: string) {
  return requestToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: token,
  });
}

export async function githubJson<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: githubHeaders(token) });
  if (!res.ok) throw new Error(`GitHub ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}
