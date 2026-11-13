// vault-web: 画面で直したノートを GitHub に保存する（Worker の /api/gh/commit。CLI の書き込みと同じ口）。
//
// 保存には「読んだときの版」（Git の blob SHA）を添える。画面は版の記録を持たないので、
// 開いたときの本文から Git と同じ計算で出す。GitHub で先に変わっていれば Worker が断る（409）ので、
// GitHub の今の本文を取って3方向でまとめ、送り直す。同じ所がぶつかったら、印付きのまとめを編集画面に戻し、
// 人に直してもらう（GitHub のノートには触らない）。
// 保存するまでの本文は、このブラウザに下書きとして残す（閉じても、読み込み直しても消えない）。

import { githubApiFetch } from "./vault_web_fetch.ts";
import { hasMergeConflict, mergeText } from "./vault_web_merge.ts";

type Repo = { owner: string; repo: string; branch: string };
type Fetch = typeof githubApiFetch;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
/** GitHub で続けて変わったときに、まとめ直す回数 */
const maxRounds = 3;

/** Git の blob SHA（"blob <長さ>\0" と中身の SHA-1） */
export async function gitBlobSha(data: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${data.length}\0`);
  const all = new Uint8Array(header.length + data.length);
  all.set(header);
  all.set(data, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** UTF-8 でなければ undefined（直せない） */
export function decodeNote(data: Uint8Array): string | undefined {
  try {
    return decoder.decode(data);
  } catch {
    return undefined;
  }
}

function base64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = "";
  // 大きいノートでも引数の数の上限を超えないよう、少しずつ文字にする
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 編集を始めた（最後にまとめた）ときの GitHub の本文と版。新しく作ったばかりなら sha は null */
export type Base = { text: string; sha: string | null };

export type SaveOutcome =
  | { status: "saved"; sha: string; merged: boolean }
  /** 同じ所がぶつかった。text は印付きのまとめ。base は GitHub の今の版（直したら、これを添えて保存し直す） */
  | { status: "conflict"; text: string; base: Base };

export class SaveError extends Error {}

export async function saveNote(
  apiBase: string,
  repo: Repo,
  path: string,
  base: Base,
  text: string,
  fetchApi: Fetch = githubApiFetch,
): Promise<SaveOutcome> {
  if (hasMergeConflict(text)) {
    throw new SaveError("conflict-markers");
  }
  let merged = false;
  for (let round = 0; round < maxRounds; round++) {
    const res = await fetchApi(
      apiBase,
      "/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ path, content: base64(text), baseSha: base.sha }] }),
      },
      { redirectToLogin: false },
    );
    if (res.ok) {
      const body = (await res.json()) as { files?: { path: string; sha: string }[] };
      const sha = body.files?.find((file) => file.path === path)?.sha;
      if (!sha) throw new SaveError("no-sha");
      return { status: "saved", sha, merged };
    }
    if (res.status === 401) throw new SaveError("login");
    // 別のタブで、開くリポジトリが切り替わった（worker/index.ts）
    if (res.status === 412) throw new SaveError("other-repo");
    if (res.status !== 409) throw new SaveError(`HTTP ${res.status}`);
    const body = (await res.json()) as { conflicts?: { path: string; sha: string | null }[] };
    const conflict = body.conflicts?.find((c) => c.path === path);
    if (!conflict) throw new SaveError("no-conflict-entry");
    // GitHub で消されていたら、空のノートから作り直したことにする
    const theirs: Base = {
      text: conflict.sha ? await readBlob(apiBase, repo, conflict.sha, fetchApi) : "",
      sha: conflict.sha,
    };
    const result = mergeText(base.text, text, theirs.text);
    if (result.conflicts > 0) return { status: "conflict", text: result.text, base: theirs };
    text = result.text;
    base = theirs;
    merged = true;
  }
  throw new SaveError("busy");
}

async function readBlob(apiBase: string, { owner, repo }: Repo, sha: string, fetchApi: Fetch): Promise<string> {
  const res = await fetchApi(
    apiBase,
    `/repos/${owner}/${repo}/git/blobs/${sha}`,
    { headers: { Accept: "application/vnd.github.raw+json" } },
    { redirectToLogin: false },
  );
  if (res.status === 401) throw new SaveError("login");
  if (!res.ok) throw new SaveError(`blob HTTP ${res.status}`);
  const text = decodeNote(new Uint8Array(await res.arrayBuffer()));
  if (text === undefined) throw new SaveError("not-utf8");
  return text;
}

// --- 下書き ---
// 下書きは、リポジトリ・ノート・編集を開いた回（id）ごとに分けて残す。同じノートを2つのタブで直しても、
// 片方の保存や取り消しで、もう片方の下書きを消さない。開くときは、いちばん新しい下書きを引き継ぐ。

export type Draft = { text: string; base: Base; savedAt: number };
export type DraftScope = { repo: Repo; path: string };
type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const draftPrefix = "vw-draft:";

function storage(): DraftStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function scopePrefix({ repo, path }: DraftScope): string {
  return `${draftPrefix}${JSON.stringify([repo.owner, repo.repo, repo.branch, path])}:`;
}

export function newDraftId(): string {
  return crypto.randomUUID();
}

function parseDraft(raw: string | null): Draft | undefined {
  try {
    const draft = JSON.parse(raw ?? "null") as Draft | null;
    if (!draft || typeof draft.text !== "string" || typeof draft.base?.text !== "string") return undefined;
    if (draft.base.sha !== null && typeof draft.base.sha !== "string") return undefined;
    return draft;
  } catch {
    return undefined;
  }
}

/** そのノートの下書き。新しい順 */
export function listDrafts(scope: DraftScope, store: DraftStore | undefined = storage()): { id: string; draft: Draft }[] {
  if (!store) return [];
  const prefix = scopePrefix(scope);
  const found: { id: string; draft: Draft }[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(prefix)) continue;
      const draft = parseDraft(store.getItem(key));
      if (draft) found.push({ id: key.slice(prefix.length), draft });
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
}

/** 残せなければ false（ブラウザの保存場所がいっぱい、など） */
export function writeDraft(scope: DraftScope, id: string, draft: Draft, store: DraftStore | undefined = storage()): boolean {
  try {
    store?.setItem(scopePrefix(scope) + id, JSON.stringify(draft));
    return !!store;
  } catch {
    return false;
  }
}

export function clearDraft(scope: DraftScope, id: string, store: DraftStore | undefined = storage()): void {
  try {
    store?.removeItem(scopePrefix(scope) + id);
  } catch {
    // 消せなくても続ける
  }
}

/**
 * この端末に残っている下書きを、すべて消す（ログアウトするとき）。
 * 下書きには編集後の本文だけでなく、編集前の本文（base.text）も入っているので、
 * 消さずに残すと、共有の端末でノートの中身が読めてしまう。
 * 消した数を返す
 */
export function clearAllDrafts(store: DraftStore | undefined = storage()): number {
  if (!store) return 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(draftPrefix)) keys.push(key);
    }
  } catch {
    return 0;
  }
  let removed = 0;
  for (const key of keys) {
    try {
      store.removeItem(key);
      removed++;
    } catch {
      // 消せないものは数えない
    }
  }
  return removed;
}
