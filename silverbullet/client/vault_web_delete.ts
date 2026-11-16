// vault-web: 開いているノートの削除。上部のバーの「編集」の隣のボタン（Library/Std/Rootlore/Home.md）と、コマンドから。
// 読んだときの版を添えて Worker に送り（worker/delete.ts）、その間に誰か（AI など）が書き換えていたら消さない。
// 消したノートも GitHub の履歴には残るので、確認のダイアログでそれを伝える。
import { sync } from "@silverbulletmd/silverbullet/syscalls";
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import type { Client } from "./client.ts";
import type { CommandHook } from "./plugos/hooks/command.ts";
import { githubApiFetch } from "./vault_web_fetch.ts";
import { isInlineEditing } from "./vault_web_inline_edit.ts";
import { gitBlobSha, listDrafts } from "./vault_web_save.ts";
import { otherRepoMessage, t } from "./vault_web_i18n.ts";

export const deleteNoteCommand = "Vault: Delete note";

export type DeleteResult = "deleted" | "conflict" | "other-repo" | "login";

/** Worker に削除を頼む。読んだときの版（baseSha）から変わっていれば conflict */
export async function requestDelete(apiBase: string, path: string, baseSha: string, fetchApi = githubApiFetch): Promise<DeleteResult> {
  const res = await fetchApi(apiBase, "/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, baseSha }),
  }, { redirectToLogin: false });
  if (res.status === 409) return "conflict";
  if (res.status === 412) return "other-repo";
  if (res.status === 401) return "login";
  if (!res.ok) throw new Error(`Delete HTTP ${res.status}`);
  return "deleted";
}

export function registerVaultDeleteCommand(client: Client, hook: CommandHook) {
  if (!client.bootConfig.githubRepo) return;
  let deleting = false;
  hook.registerCommand({
    name: deleteNoteCommand,
    run: async () => {
      if (deleting) return;
      deleting = true;
      try {
        await deleteCurrentNote(client);
      } finally {
        deleting = false;
      }
    },
  });
}

async function deleteCurrentNote(client: Client): Promise<void> {
  const repo = client.bootConfig.githubRepo;
  const path = client.currentPath();
  if (!repo || !path) return;
  if (isInlineEditing(client, path)) {
    client.ui.flashNotification(t("編集を終えてから削除してください。", "Finish editing before deleting this note."), "error");
    return;
  }
  if (listDrafts({ repo, path }).length > 0) {
    client.ui.flashNotification(t("下書きがあるため削除できません。保存または破棄してから削除してください。", "Save or discard the draft before deleting this note."), "error");
    return;
  }
  const confirmed = await client.ui.confirm(
    t(
      `「${path}」を削除しますか？\n削除したノートも GitHub の履歴には残り、そこから戻せます。`,
      `Delete "${path}"?\nThe note stays in the GitHub history, and you can restore it from there.`,
    ),
    { destructive: true },
  );
  if (!confirmed) return;
  let committed = false;
  try {
    client.ui.flashNotification(t("削除しています…", "Deleting…"));
    const { data } = await client.space.spacePrimitives.readFile(path);
    const result = await requestDelete(`${document.baseURI.replace(/\/*$/, "")}/api/gh`, path, await gitBlobSha(data));
    if (result !== "deleted") {
      client.ui.flashNotification(
        result === "conflict"
          ? t("このノートは読み込んだあとに変更されたため、削除を止めました。最新の状態に更新して確かめてください。", "This note changed after it was loaded, so it wasn't deleted. Refresh from GitHub and check it.")
          : result === "other-repo"
          ? otherRepoMessage()
          : t("ログインし直してから削除してください。", "Sign in again before deleting this note."),
        "error",
      );
      return;
    }
    committed = true;
    await sync.performSpaceSync();
    await client.navigate({ path: client.getIndexRef().path as Path });
    client.ui.flashNotification(t("削除しました。GitHub の履歴から戻せます。", "Deleted. You can restore it from the GitHub history."));
  } catch (e) {
    client.ui.flashNotification(
      committed
        ? t("削除しましたが、表示を更新できませんでした。再読み込みしてください。", "Deleted, but the view couldn't refresh. Please reload.")
        : t("削除の完了を確認できませんでした。最新の状態に更新して確認してください。", "Couldn't confirm the delete. Refresh from GitHub to check."),
      "error",
    );
    client.reportError(e, "delete note");
  }
}
