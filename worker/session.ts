// ログイン情報は Cookie に暗号化して持つ。アプリ側にデータベースは置かない。

/** 開いているリポジトリ（worker/repos.ts で選ぶ）。選ぶ前のログインには無い */
export type SessionRepo = { owner: string; repo: string; branch: string };

export type Session = {
  login: string;
  repo?: SessionRepo;
  accessToken: string;
  /** epoch ms */
  accessTokenExpiresAt: number;
  refreshToken: string;
  /** epoch ms */
  refreshTokenExpiresAt: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export async function seal(data: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importKey(secret),
    encoder.encode(JSON.stringify(data)),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

/** 改ざん・鍵違い・形式不正はすべて null。 */
export async function unseal<T>(token: string, secret: string): Promise<T | null> {
  const [ivPart, cipherPart] = token.split(".");
  if (!ivPart || !cipherPart) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart) },
      await importKey(secret),
      fromBase64Url(cipherPart),
    );
    return JSON.parse(decoder.decode(plain)) as T;
  } catch {
    return null;
  }
}
