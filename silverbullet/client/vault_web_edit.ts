// vault-web: 「GitHub で直す」。開いているノートの GitHub の編集画面を、小さな別ウィンドウ（ポップアップ）で開く。
// 保存（commit）と、編集中に GitHub 側で変わったときの扱いは、GitHub の編集画面に任せる。
// GitHub の画面は、ほかのサイトの中に埋め込めない（frame-ancestors 'none'）ので、別のウィンドウにする。
// ウィンドウを閉じたとき、この画面に戻ってきたときに最新を読み込み、直した内容を出す。

import type { Client } from "./client.ts";
import type { CommandHook } from "./plugos/hooks/command.ts";
import { t } from "./vault_web_i18n.ts";
import { openNoteEditor } from "./components/vault_web_note_editor.tsx";
import { listDrafts } from "./vault_web_save.ts";
import { shortcutKeys } from "./vault_web_shortcuts.ts";

type Repo = { owner: string; repo: string; branch: string };

export const editOnGitHubCommand = "Vault: Edit on GitHub";
/** 上部のバーの「編集」。この画面で直して保存する（components/vault_web_note_editor.tsx） */
export const editNoteCommand = "Vault: Edit note";
/** 上部のバーの「履歴」。開いているノートの変更の履歴（だれが・いつ・どこを変えたか）を GitHub で開く */
export const noteHistoryCommand = "Vault: Note history";
/** 編集画面を開いてから、この間は、戻ってくるたびに最新を読み込む */
const watchReturnMs = 30 * 60 * 1000;
/** 続けて戻ってきたときに、何度も読み込まない */
const minReloadIntervalMs = 10 * 1000;
/** 編集のウィンドウの名前。押すたびに増やさず、同じウィンドウを使い回す */
const editWindowName = "vault-web-github-edit";

type ScreenLike = {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  availWidth: number;
  availHeight: number;
};

/** 編集のウィンドウの大きさと位置。幅 1000・高さ 800 を上限に、今の画面の真ん中に重ねる */
export function editWindowFeatures(s: ScreenLike): string {
  const width = Math.max(480, Math.min(1000, s.availWidth - 80));
  const height = Math.max(480, Math.min(800, s.availHeight - 80));
  const left = Math.max(0, Math.round(s.screenX + (s.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(s.screenY + (s.outerHeight - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

const stdLibPrefix = "Library/Std/";

/** GitHub の編集画面の URL。直せないページ（ホーム、見つからないページ、同梱のページ）は undefined */
export function editUrlFor(
  repo: Repo,
  path: string,
  lastModified: string | undefined,
): string | undefined {
  // ファイルがなく、その場で作った中身（ホーム、「ページが見つかりません」、仮想ページ）には日時がない
  if (!lastModified || !path.endsWith(".md") || path.startsWith(stdLibPrefix)) {
    return undefined;
  }
  const encode = (value: string) =>
    value.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/edit/${encode(repo.branch)}/${encode(path)}`;
}

/** GitHub のファイルの変更の履歴の URL。開けないページは undefined（editUrlFor と同じ条件） */
export function historyUrlFor(
  repo: Repo,
  path: string,
  lastModified: string | undefined,
): string | undefined {
  if (!editUrlFor(repo, path, lastModified)) return undefined;
  const encode = (value: string) =>
    value.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${encode(repo.branch)}/${encode(path)}`;
}

/**
 * この画面で直せるか。GitHub の編集画面で開けるノートと同じ（リポジトリの .md。ホームや同梱のページは除く）。
 * ただし、このブラウザにそのノートの下書きがあれば、ノートが GitHub で消されていても直せる
 * （下書きに戻れないと、直しかけの本文に画面からたどり着けない）
 */
export function canEditNote(
  repo: Repo,
  path: string,
  lastModified: string | undefined,
  hasDraft: (path: string) => boolean = (p) => listDrafts({ repo, path: p }).length > 0,
): boolean {
  if (editUrlFor(repo, path, lastModified)) return true;
  return path.endsWith(".md") && !path.startsWith(stdLibPrefix) && hasDraft(path);
}

export function registerVaultWebEditCommand(client: Client, hook: CommandHook) {
  const repo = client.bootConfig.githubRepo;
  if (!repo) return;
  let openedAt = 0;
  let reloadedAt = 0;
  let closeWatch: ReturnType<typeof setInterval> | undefined;

  /** 編集から戻ってきたら最新を読み込む（開いてから30分の間。続けて何度も読み込まない） */
  const reloadAfterEditing = () => {
    const now = Date.now();
    if (now - openedAt > watchReturnMs || now - reloadedAt < minReloadIntervalMs) {
      return;
    }
    reloadedAt = now;
    void client.runCommandByName("Sync: Space").catch((e) =>
      client.reportError(e, "reload after editing on GitHub"),
    );
  };

  hook.registerCommand({
    name: editNoteCommand,
    ...shortcutKeys(editNoteCommand),
    requireEditor: "page",
    run: async () => {
      const path = client.currentPath();
      if (!canEditNote(repo, path, client.currentPageMeta()?.lastModified)) {
        client.ui.flashNotification(
          t(
            "このページは編集できません。編集できるのはリポジトリ内のノートのみです。",
            "This page can't be edited. Only notes in the repository can be edited.",
          ),
          "error",
        );
        return;
      }
      await openNoteEditor(path, client);
    },
  });

  hook.registerCommand({
    name: noteHistoryCommand,
    requireEditor: "page",
    run: async () => {
      const url = historyUrlFor(repo, client.currentPath(), client.currentPageMeta()?.lastModified);
      if (!url) {
        client.ui.flashNotification(
          t(
            "このページには履歴がありません。履歴を見られるのはリポジトリ内のノートのみです。",
            "This page has no history. Only notes in the repository have a history.",
          ),
          "error",
        );
        return;
      }
      // "noopener" を付けると開けたかどうかが分からないので、開いたあとで切り離す
      const opened = globalThis.open(url, "_blank");
      if (!opened) {
        client.ui.flashNotification(
          t(
            "GitHubの履歴を開けませんでした。ブラウザでポップアップがブロックされていないか確認してください。",
            "Couldn't open the history on GitHub. Check whether your browser is blocking pop-ups.",
          ),
          "error",
        );
        return;
      }
      opened.opener = null;
    },
  });

  hook.registerCommand({
    name: editOnGitHubCommand,
    requireEditor: "page",
    run: async () => {
      const url = editUrlFor(
        repo,
        client.currentPath(),
        client.currentPageMeta()?.lastModified,
      );
      if (!url) {
        client.ui.flashNotification(
          t(
            "このページはGitHubで編集できません。編集できるのはリポジトリ内のノートのみです。",
            "This page can't be edited on GitHub. Only notes in the repository can be edited.",
          ),
          "error",
        );
        return;
      }
      // ボタンを押した直後に開く（間に待ちを挟むと、ブラウザがポップアップとして止めることがある）
      const opened = globalThis.open(
        url,
        editWindowName,
        editWindowFeatures({
          screenX: globalThis.screenX,
          screenY: globalThis.screenY,
          outerWidth: globalThis.outerWidth,
          outerHeight: globalThis.outerHeight,
          availWidth: globalThis.screen.availWidth,
          availHeight: globalThis.screen.availHeight,
        }),
      );
      if (!opened) {
        client.ui.flashNotification(
          t(
            "GitHubの編集画面を開けませんでした。ブラウザでポップアップがブロックされていないか確認してください。",
            "Couldn't open the GitHub editor. Check whether your browser is blocking pop-ups.",
          ),
          "error",
        );
        return;
      }
      // 開いた先からこのタブを操作させない（"noopener" を付けると、開けたかどうかが分からなくなる）
      opened.opener = null;
      // 開いたままのウィンドウを使い回したときも、手前に出す
      opened.focus();
      openedAt = Date.now();
      // ウィンドウを閉じたら最新を読み込む。閉じたかどうかは、別のサイトのウィンドウでも分かる
      clearInterval(closeWatch);
      closeWatch = setInterval(() => {
        if (!opened.closed && Date.now() - openedAt <= watchReturnMs) return;
        clearInterval(closeWatch);
        if (opened.closed) reloadAfterEditing();
      }, 1000);
    },
  });

  // ポップアップを開いたまま、この画面に戻ってきた（クリックした）とき
  globalThis.addEventListener("focus", reloadAfterEditing);
  // スマートフォンなどで、ポップアップがタブとして開いたとき
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    reloadAfterEditing();
  });
}
