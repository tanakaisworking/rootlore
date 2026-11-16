// vault-web: 上部のバーの「パスをコピー」。AI などに「このノート（フォルダ）のこと」と伝えるために、
// vault の中での場所を写す（例: 0_AgentBrain/Projects/rootlore/index.md、フォルダは 0_AgentBrain/Projects/）。
// vault のファイルではないページ（設定などのアプリのページ、作ったホーム、見つからないページ）では出さない

export type CopyPathContext = {
  /** 設定・アカウントなど、アプリのページか（components/vault_web_dialogs.tsx の vaultWebPageFor） */
  appPage: boolean;
  /** GitHub から作ったホームを出している名前（content_manager.ts） */
  homeShown?: string;
  /** 中身の一覧を出しているフォルダの名前（content_manager.ts） */
  folderShown?: string;
  /** 「ページが見つかりません」を出している名前（content_manager.ts） */
  missingShown?: string;
};

export function copyablePath(path: string | undefined, context: CopyPathContext): string | undefined {
  if (!path || context.appPage || path.startsWith("Library/")) return undefined;
  const name = path.replace(/\.md$/, "");
  if (name === context.homeShown || name === context.missingShown) return undefined;
  if (name === context.folderShown) return `${name}/`;
  return path;
}
