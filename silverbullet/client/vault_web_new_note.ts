import { sync } from "@silverbulletmd/silverbullet/syscalls";
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import type { Client } from "./client.ts";
import type { CommandHook } from "./plugos/hooks/command.ts";
import { githubApiFetch } from "./vault_web_fetch.ts";
import { shortcutKeys } from "./vault_web_shortcuts.ts";
import { openNoteEditor } from "./components/vault_web_note_editor.tsx";
import { otherRepoMessage, t } from "./vault_web_i18n.ts";
import { copyablePath } from "./vault_web_copy_path.ts";

/** 左のサイドバーの検索の隣の「ここに新しいノート」（Library/Std/Rootlore/Home.md） */
export const newNoteHereCommand = "Vault: New note here";

/**
 * 「ここに新しいノート」で作る場所。ノートを開いていればそのノートと同じフォルダ、フォルダの一覧ならその中、
 * vault のファイルでないページ（ホーム、設定など）なら一番上（""）。copyable は vault_web_copy_path.ts の copyablePath
 */
export function newNoteFolder(copyable: string | undefined): string {
  if (!copyable) return "";
  if (copyable.endsWith("/")) return copyable;
  const slash = copyable.lastIndexOf("/");
  return slash < 0 ? "" : copyable.slice(0, slash + 1);
}

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
  hook.registerCommand({
    name: "Vault: New note", ...shortcutKeys("Vault: New note"),
    run: () => createNote(client, ""),
  });
}

/** 開いているノートと同じ場所に、仮の名前（無題のノート）ですぐ作って開く。名前はタイトルを押して変える（vault_web_move.ts） */
export function registerVaultNewNoteHereCommand(client: Client, hook: CommandHook) {
  if (!client.bootConfig.githubRepo) return;
  hook.registerCommand({
    name: newNoteHereCommand,
    run: () => {
      const content = client.contentManager;
      const folder = newNoteFolder(copyablePath(client.currentPath(), {
        appPage: false, // アプリのページは Library/ の下にあり、copyablePath が外す
        homeShown: content?.vaultWebHomeShown,
        folderShown: content?.vaultWebFolderShown,
        missingShown: content?.missingPageShown,
      }));
      return createNote(client, folder, false);
    },
  });
}

let creating = false;

/** サイドバーの右クリックの「ここに新しいノート」。folder は末尾に / を付けた場所か ""（一番上） */
export function createNoteIn(client: Client, folder: string): Promise<void> {
  return createNote(client, folder, false);
}

/** 仮の名前がふさがっているとき、番号を付けて試す回数 */
const UNTITLED_TRIES = 20;

/**
 * folder の中に空のノートを作り、開いて編集を始める。ask なら名前を聞く（folder が "" なら名前でフォルダも指定できる）。
 * ask でなければ「無題のノート」で作り、同じ名前があれば「無題のノート 2」のように番号を付ける
 */
async function createNote(client: Client, folder: string, ask = true): Promise<void> {
  if (creating) return;
  if (document.querySelector("#sb-top .vw-inline-editor-controls")) {
    client.ui.flashNotification(t("編集中のノートを閉じてから作成してください。", "Close the note editor before creating a note."), "error");
    return;
  }
  creating = true;
  let committed = false;
  try {
    const untitled = t("無題のノート", "Untitled note");
    let candidates: (string | undefined)[];
    if (ask) {
      const question = folder
        ? t(`新しいノートの名前（作る場所: ${folder}）`, `New note name (in ${folder})`)
        : t("新しいノートの名前（フォルダ/名前も指定できます）", "New note name (folder/name is also supported)");
      const name = await client.ui.prompt(question, untitled);
      if (name === undefined) return;
      candidates = [newNotePath(folder + name.trim())];
    } else {
      candidates = Array.from({ length: UNTITLED_TRIES }, (_, i) => newNotePath(folder + (i === 0 ? untitled : `${untitled} ${i + 1}`)));
    }
    if (!candidates[0]) {
      client.ui.flashNotification(t("ノート名を確認してください。空の名前や「.」で始まる名前は使えません。", "Check the note name. Empty names and names starting with a dot aren't allowed."), "error");
      return;
    }
    let path = "";
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        await createEmptyNote(`${document.baseURI.replace(/\/*$/, "")}/api/gh`, candidate);
        path = candidate;
        break;
      } catch (e) {
        // 仮の名前がふさがっていれば、次の番号を試す。名前を聞いたときは、そのまま知らせる
        if (ask || !(e instanceof NewNoteError && e.message === "exists")) throw e;
      }
    }
    if (!path) throw new NewNoteError("exists");
    committed = true;
    await sync.performSpaceSync();
    await client.navigate({ path: path as Path });
    openNoteEditor(path);
    client.ui.flashNotification(ask
      ? t("ノートを作成しました。", "Note created.")
      : t("ノートを作成しました。名前はタイトルを押すと変えられます。", "Note created. Click the title to rename it."));
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
}
