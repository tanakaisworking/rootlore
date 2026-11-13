import { sync } from "@silverbulletmd/silverbullet/syscalls";
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import type { Client } from "./client.ts";
import type { CommandHook } from "./plugos/hooks/command.ts";
import { githubApiFetch } from "./vault_web_fetch.ts";
import { shortcutKeys } from "./vault_web_shortcuts.ts";
import { openNoteEditor } from "./components/vault_web_note_editor.tsx";
import { otherRepoMessage, t } from "./vault_web_i18n.ts";

export function newNotePath(name: string): string | undefined {
  const value = name.trim();
  if (!value) return;
  const path = /\.md$/i.test(value) ? value.slice(0, -3) + ".md" : value + ".md";
  if (path.length > 1024 || path.startsWith("Library/Std/") || /[\\:\u0000-\u001f\u007f]/.test(path)) return;
  if (!path.split("/").every((part) => part.length > 0 && !part.startsWith("."))) return;
  return path;
}

export class NewNoteError extends Error {}

/** baseSha:nullで空のノートを作る。同名ファイルはマージも上書きもしない。 */
export async function createEmptyNote(apiBase: string, path: string, fetchApi = githubApiFetch): Promise<void> {
  const res = await fetchApi(apiBase, "/commit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ path, content: "", baseSha: null }] }),
  }, { redirectToLogin: false });
  if (res.status === 409) throw new NewNoteError("exists");
  if (res.status === 412) throw new NewNoteError("other-repo");
  if (res.status === 401) throw new NewNoteError("login");
  if (!res.ok) throw new NewNoteError(`HTTP ${res.status}`);
  const body = await res.json() as { files?: { path: string; sha: string }[] };
  if (!body.files?.some((file) => file.path === path && /^[a-f0-9]{40}$/.test(file.sha))) throw new NewNoteError("no-file");
}

export function registerVaultNewNoteCommand(client: Client, hook: CommandHook) {
  if (!client.bootConfig.githubRepo) return;
  let creating = false;
  hook.registerCommand({
    name: "Vault: New note", ...shortcutKeys("Vault: New note"),
    run: async () => {
      if (creating) return;
      if (document.querySelector("#sb-top .vw-inline-editor-controls")) {
        client.ui.flashNotification(t("編集中のノートを閉じてから作成してください。", "Close the note editor before creating a note."), "error");
        return;
      }
      creating = true;
      let committed = false;
      try {
        const name = await client.ui.prompt(t("新しいノートの名前（フォルダ/名前も指定できます）", "New note name (folder/name is also supported)"), t("無題のノート", "Untitled note"));
        if (name === undefined) return;
        const path = newNotePath(name);
        if (!path) {
          client.ui.flashNotification(t("ノート名を確認してください。空の名前や「.」で始まる名前は使えません。", "Check the note name. Empty names and names starting with a dot aren't allowed."), "error");
          return;
        }
        await createEmptyNote(`${document.baseURI.replace(/\/*$/, "")}/api/gh`, path);
        committed = true;
        await sync.performSpaceSync();
        await client.navigate({ path: path as Path });
        openNoteEditor(path);
        client.ui.flashNotification(t("ノートを作成しました。", "Note created."));
      } catch (e) {
        const message = e instanceof NewNoteError && e.message === "exists"
          ? t("同じ名前のノートがあります。別の名前で作成してください。", "A note with this name already exists. Choose another name.")
          : e instanceof NewNoteError && e.message === "other-repo"
          ? otherRepoMessage()
          : e instanceof NewNoteError && e.message === "login"
          ? t("ログインし直してから作成してください。", "Sign in again before creating a note.")
          : committed
          ? t("ノートを作成しましたが、表示を更新できませんでした。再読み込みしてください。", "The note was created, but the view couldn't refresh. Please reload.")
          : t("作成の完了を確認できませんでした。最新の状態に更新して確認してください。", "Couldn't confirm creation. Refresh from GitHub to check.");
        client.ui.flashNotification(message, "error");
        if (!(e instanceof NewNoteError)) client.reportError(e, "create note");
      } finally { creating = false; }
    },
  });
}
