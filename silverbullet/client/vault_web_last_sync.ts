// vault-web: このブラウザが GitHub から最後に読み込み終えた（同期が成功した）時刻。
// Service Worker の「全体の同期が終わった」（space-sync-complete。成功したときだけ届く）で client.ts が残す。
// アカウントのページの「最終同期」に出す。localStorage に残すので、読み込み直しても前回の時刻が分かる

const lastSyncKey = "vw-last-sync";
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // 保存を止めているブラウザ
  }
}

/** 最後に同期が終わった時刻（ミリ秒）。まだなら undefined */
export function readLastSync(
  store: Pick<Storage, "getItem"> | undefined = storage(),
): number | undefined {
  const value = Number(store?.getItem(lastSyncKey));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function recordLastSync(time = Date.now()): void {
  try {
    storage()?.setItem(lastSyncKey, String(time));
  } catch {
    // 残せなくても、開いている間の表示には効かせる
  }
  for (const listener of listeners) listener();
}

export function clearLastSync(): void {
  try {
    storage()?.removeItem(lastSyncKey);
  } catch {
    // 消せなくても続ける
  }
}

export function subscribeLastSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
