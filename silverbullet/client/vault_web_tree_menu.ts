// vault-web: サイドバーのファイル一覧を右クリックしたときのメニュー（navigator/ui/components/nav_root.tsx）。
// どれも既にある操作（開く・名前を変える・パスをコピー・ここに新しいノート・削除）を、右クリックした行に対して行う。
// フォルダの削除は、中身ごと消えてしまうので出さない。
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import type { Client } from "./client.ts";
import type { MenuItem } from "./components/anchored_menu.tsx";
import { copyToClipboard } from "./clipboard.ts";
import { deleteVaultFile } from "./vault_web_delete.ts";
import { t } from "./vault_web_i18n.ts";
import { moveVaultFile, moveVaultFolder, renamedFolder, renamedPath } from "./vault_web_move.ts";
import { createNoteIn } from "./vault_web_new_note.ts";

/** ツリーの行が持つもの（tree_model.ts の nodeObject）。フォルダの name は末尾の / なし */
export type TreeMenuTarget = {
  name: string;
  isFolder?: boolean;
  ref?: unknown;
  tag?: string;
  lastModified?: string | number;
};

export type TreeMenuAction =
  | { kind: "open"; path: string }
  | { kind: "rename-file"; path: string }
  | { kind: "rename-folder"; folder: string }
  | { kind: "copy-path"; path: string }
  | { kind: "new-note"; folder: string }
  | { kind: "delete"; path: string };

/** 右クリックした行に出す操作。上から順に並べる */
export function treeMenuActions(obj: TreeMenuTarget): TreeMenuAction[] {
  if (!obj.name || obj.name.startsWith("Library/")) return [];
  // フォルダだけの行。同じ名前のノートもあるフォルダは、ノートの行として扱う
  if (obj.isFolder && obj.ref == null) {
    return [
      { kind: "new-note", folder: `${obj.name}/` },
      { kind: "rename-folder", folder: obj.name },
      { kind: "copy-path", path: `${obj.name}/` },
    ];
  }
  const path = obj.tag === "document" ? obj.name : `${obj.name}.md`;
  const actions: TreeMenuAction[] = [{ kind: "open", path }];
  // ノートとフォルダの組は、名前を変えるとノートだけが動いて組が崩れるので出さない
  if (!obj.isFolder) actions.push({ kind: "rename-file", path });
  actions.push(
    { kind: "copy-path", path },
    { kind: "new-note", folder: obj.isFolder ? `${obj.name}/` : path.slice(0, path.lastIndexOf("/") + 1) },
    { kind: "delete", path },
  );
  return actions;
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

const badName = () => t(
  "名前を確認してください。空の名前、「.」で始まる名前、/ を含む名前は使えません。",
  "Check the name. Empty names, names starting with a dot, and names with / aren't allowed.",
);

export function treeMenuItems(client: Client, obj: TreeMenuTarget): MenuItem[] {
  return treeMenuActions(obj).map((action): MenuItem => {
    switch (action.kind) {
      case "open":
        return { name: t("開く", "Open"), run: () => void client.navigate({ path: action.path as Path }) };
      case "rename-file":
        return {
          name: t("名前を変更", "Rename"),
          run: async () => {
            const current = baseName(action.path);
            const name = await client.ui.prompt(t("新しい名前", "New name"), current);
            if (name === undefined || name.trim() === current) return;
            const next = renamedPath(action.path, name);
            if (!next) return client.ui.flashNotification(badName(), "error");
            await moveVaultFile(client, action.path, next, obj.lastModified);
          },
        };
      case "rename-folder":
        return {
          name: t("名前を変更", "Rename"),
          run: async () => {
            const current = action.folder.slice(action.folder.lastIndexOf("/") + 1);
            const name = await client.ui.prompt(t("フォルダの新しい名前", "New folder name"), current);
            if (name === undefined || name.trim() === current) return;
            const next = renamedFolder(action.folder, name);
            if (!next) return client.ui.flashNotification(badName(), "error");
            await moveVaultFolder(client, action.folder, next);
          },
        };
      case "copy-path":
        return {
          name: t("パスをコピー", "Copy path"),
          run: async () => {
            try {
              await copyToClipboard(action.path);
              client.ui.flashNotification(t("パスをコピーしました。", "Path copied."));
            } catch {
              client.ui.flashNotification(t("パスをコピーできませんでした。", "Couldn't copy the path."), "error");
            }
          },
        };
      case "new-note":
        return { name: t("ここに新しいノート", "New note here"), run: () => void createNoteIn(client, action.folder) };
      case "delete":
        return { name: t("削除", "Delete"), run: () => void deleteVaultFile(client, action.path) };
    }
  });
}
