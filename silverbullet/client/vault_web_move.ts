import { sync } from "@silverbulletmd/silverbullet/syscalls";
import type { Client } from "./client.ts";
import { isInlineEditing } from "./vault_web_inline_edit.ts";
import { githubApiFetch } from "./vault_web_fetch.ts";
import { gitBlobSha, listDrafts } from "./vault_web_save.ts";
import { otherRepoMessage, t } from "./vault_web_i18n.ts";
import { parsePageMetaLastModified } from "./lib/page_meta.ts";
import { notFoundError } from "@silverbulletmd/silverbullet/constants";
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import type { CommandHook } from "./plugos/hooks/command.ts";
import { shortcutKeys } from "./vault_web_shortcuts.ts";

export const moveConflictMessage = () => t(
  "最新版と衝突するため移動を一時停止しました",
  "Move paused because it conflicts with the latest version.",
);

let moving = false;
type Move = { source: string; destination: string; sha: string };
const histories = new WeakMap<Client, { undo: Move[]; redo: Move[] }>();
function historyFor(client: Client) {
  let history = histories.get(client);
  if (!history) { history = { undo: [], redo: [] }; histories.set(client, history); }
  return history;
}

export function registerVaultMoveCommands(client: Client, hook: CommandHook) {
  if (!client.bootConfig.githubRepo) return;
  hook.registerCommand({ name: "Vault: Undo move", ...shortcutKeys("Vault: Undo move"), run: () => undoVaultMove(client) });
  hook.registerCommand({ name: "Vault: Redo move", ...shortcutKeys("Vault: Redo move"), run: () => redoVaultMove(client) });
}

export function undoVaultMove(client: Client): Promise<boolean> {
  return replayMove(client, "undo");
}
export function redoVaultMove(client: Client): Promise<boolean> {
  return replayMove(client, "redo");
}

async function replayMove(client: Client, direction: "undo" | "redo"): Promise<boolean> {
  const history = historyFor(client);
  const move = history[direction].at(-1);
  if (!move || moving) return false;
  const source = direction === "undo" ? move.destination : move.source;
  const destination = direction === "undo" ? move.source : move.destination;
  return performMove(client, source, destination, undefined, move.sha, () => {
    history[direction].pop();
    history[direction === "undo" ? "redo" : "undo"].push(move);
  });
}

/** GitHubが受け付けるまで、一覧も手元のファイルも動かさない。 */
export async function moveVaultFile(client: Client, source: string, destination: string, lastModified?: string | number): Promise<boolean> {
  return performMove(client, source, destination, lastModified, undefined, (sha) => {
    const history = historyFor(client);
    history.undo.push({ source, destination, sha });
    history.redo.length = 0;
  });
}

async function performMove(client: Client, source: string, destination: string, lastModified: string | number | undefined, expectedSha: string | undefined, onCommit: (sha: string) => void): Promise<boolean> {
  const repo = client.bootConfig.githubRepo;
  if (!repo || moving) return false;
  if (isInlineEditing(client, source) || isInlineEditing(client, destination)) {
    client.ui.flashNotification(t("編集中のノートは移動できません。編集を完了してから移動してください。", "Finish editing this note before moving it."), "error");
    return false;
  }
  if ([source, destination].some((path) => listDrafts({ repo, path }).length > 0)) {
    client.ui.flashNotification(t("下書きがあるため移動できません。保存または破棄してから移動してください。", "Save or discard the draft before moving this file."), "error");
    return false;
  }
  moving = true;
  let committed = false;
  try {
    client.ui.flashNotification(t("移動しています…", "Moving…"));
    const { data, meta } = await client.space.spacePrimitives.readFile(source);
    const expected = typeof lastModified === "string" ? parsePageMetaLastModified(lastModified) : lastModified;
    if (expected !== undefined && expected !== meta.lastModified) {
      client.ui.flashNotification(moveConflictMessage(), "error");
      return false;
    }
    const baseSha = await gitBlobSha(data);
    if (expectedSha !== undefined && expectedSha !== baseSha) {
      client.ui.flashNotification(moveConflictMessage(), "error");
      return false;
    }
    const res = await githubApiFetch(`${document.baseURI.replace(/\/*$/, "")}/api/gh`, "/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, destination, baseSha }),
    }, { redirectToLogin: false });
    if (res.status === 409) {
      client.ui.flashNotification(moveConflictMessage(), "error");
      return false;
    }
    if (res.status === 412) {
      client.ui.flashNotification(otherRepoMessage(), "error");
      return false;
    }
    if (!res.ok) throw new Error(`Move HTTP ${res.status}`);
    committed = true;
    // 表示の同期に失敗してもGitHubの移動は成立済み。取り消し履歴をここで確定する。
    onCommit(baseSha);
    await sync.performSpaceSync();
    if (client.currentPath() === source) await client.navigate({ path: destination as Path });
    client.ui.flashNotification(t("移動しました。", "Moved."));
    return true;
  } catch (e) {
    if (e === notFoundError) {
      client.ui.flashNotification(moveConflictMessage(), "error");
      return false;
    }
    client.ui.flashNotification(committed
      ? t("移動しましたが、表示を更新できませんでした。再読み込みしてください。", "Moved, but couldn't refresh the view. Please reload.")
      : t("移動の完了を確認できませんでした。最新の状態に更新して確認してください。", "Couldn't confirm the move. Refresh from GitHub to check."), "error");
    client.reportError(e, "move file");
    return false;
  } finally {
    moving = false;
  }
}
