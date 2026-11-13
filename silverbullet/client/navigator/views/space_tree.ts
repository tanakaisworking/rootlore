import { expandRefreshTriggers } from "../refresh_triggers.ts";
import {
  config,
  editor,
  space,
  system,
} from "@silverbulletmd/silverbullet/syscalls";
import { compareCollated } from "@silverbulletmd/silverbullet/lib/collation";
import type { ObjectValue } from "@silverbulletmd/silverbullet/type/index";
import type { QueryCollationConfig } from "@silverbulletmd/silverbullet/type/config";
import { isHiddenPage, isMetaPage, spaceContents } from "./pages.ts";
import { baseMeta, type BuiltinView, type Segment } from "./types.ts";
import { t } from "../../vault_web_i18n.ts";
import { documentIcon } from "../../vault_web_file_icon.ts";
import { moveVaultFile } from "../../vault_web_move.ts";

type TreeObj = Partial<ObjectValue<Record<string, any>>> & {
  name: string;
  isFolder?: boolean;
};

function treeIcon(obj: TreeObj): string {
  // Only a pure folder gets the folder icon. A dual has a page behind it and
  // reads as that page, so it falls through to the icons below like any other.
  if (obj.isFolder && obj.ref == null) return "folder";
  const decorated = obj.pageDecoration?.icon;
  if (typeof decorated === "string" && decorated !== "") return decorated;
  if (obj.isAspiring) return "file-plus";
  // vault-web: すべて読み取り専用なので、鍵（perm === "ro"）は出さず種類で分ける（vault_web_file_icon.ts）
  if (obj.tag === "document") {
    return documentIcon(obj.name, obj.contentType);
  }
  return "file-text";
}

// vault-web: 日本語にする。Meta（同梱の Library/ のページ）は vault-web では見せないので分類ごと外した
const spaceTreeSegments: Segment<TreeObj>[] = [
  {
    label: t("すべて", "All"),
    icon: "layers",
    default: true,
    placeholder: t("名前で絞り込み", "Filter by name"),
    where: (obj) => !isMetaPage(obj),
  },
  {
    label: t("ノート", "Notes"),
    icon: "file-text",
    placeholder: t("ノートの名前で絞り込み", "Filter notes by name"),
    where: (obj) => obj.tag === "page" && !isMetaPage(obj),
  },
  {
    label: t("ファイル", "Files"),
    icon: "file",
    placeholder: t("ファイルの名前で絞り込み", "Filter files by name"),
    where: (obj) => obj.tag === "document",
  },
];

/** Unlike the picker, the tree has no segment that keeps hidden pages: a page
 * hidden from navigation is hidden here too, and `tree.hide` hides it from
 * here alone. A hidden page with children still leaves its folder behind --
 * the folder is synthesized from the children's names. */
function isTreeHidden(obj: TreeObj): boolean {
  return isHiddenPage(obj) || obj.pageDecoration?.tree?.hide === true;
}

async function spaceTreeSource(): Promise<TreeObj[]> {
  const contents = await spaceContents();
  const collation = await config.get<QueryCollationConfig>(
    "queryCollation",
    {},
  );
  const collator = Intl.Collator(collation?.locale, collation?.options);
  return (contents as TreeObj[])
    .filter((obj) => !isTreeHidden(obj))
    .sort((a, b) =>
      compareCollated(String(a.name), String(b.name), collation, collator),
    );
}

async function moveByRename(obj: TreeObj, newName: string): Promise<void | boolean> {
  if (globalThis.client?.bootConfig?.githubRepo) {
    if (obj.isFolder) return false;
    const suffix = obj.tag === "document" ? "" : ".md";
    return await moveVaultFile(globalThis.client, obj.name + suffix, newName + suffix, obj.lastModified);
  }
  if (obj.isFolder) {
    // Covers documents as well as pages under the prefix.
    await system.invokeFunction("index.renamePrefixCommand", {
      oldPrefix: `${obj.name}/`,
      newPrefix: `${newName}/`,
      disableConfirmation: true,
    });
  }
  // A page that also has children is both: renamePrefixCommand only touches
  // files under "name/", so the page itself still needs its own rename.
  if (!obj.isFolder || obj.ref) {
    if (obj.tag === "document") {
      // A document's name carries its extension and is the file name itself,
      // so the page rename (which appends ".md") would rename the wrong file.
      await system.invokeFunction("index.renameDocumentCommand", {
        oldDocument: obj.name,
        document: newName,
      });
    } else {
      await system.invokeFunction("index.renamePageCommand", {
        oldPage: obj.name,
        page: newName,
      });
    }
  }
}

/** Renaming means something different for each of the three kinds of row a
 * space tree has, and only the folder case needs a prompt of its own (the
 * other two are the same commands the editor's own rename commands run). */
async function renameTreeRow(obj: TreeObj): Promise<void> {
  if (obj.isFolder) {
    const newName = await editor.prompt(`Rename ${obj.name} to:`, obj.name);
    if (newName == null) return;
    const trimmed = newName.trim();
    if (trimmed === "" || trimmed === obj.name) return;
    await moveByRename(obj, trimmed);
  } else if (obj.tag === "document") {
    await system.invokeFunction("index.renameDocumentCommand", {
      oldDocument: obj.name,
    });
  } else {
    await system.invokeFunction("index.renamePageCommand", {
      oldPage: obj.name,
    });
  }
}

async function deleteTreeRow(obj: TreeObj): Promise<void> {
  if (!(await editor.confirm(`Delete ${obj.name}?`))) return;
  if (obj.tag === "document") {
    await space.deleteDocument(obj.name);
  } else {
    await space.deletePage(obj.name);
  }
}

async function newPageUnder(obj: TreeObj): Promise<void> {
  const prefill = `${obj.name}/`;
  const name = await editor.prompt("New page name:", prefill);
  if (name == null) return;
  const trimmed = name.trim();
  // Confirming the prefill unedited means "never mind": navigating to a bare
  // "Folder/" would try to open a page with an empty last segment.
  if (trimmed === "" || trimmed === prefill) return;
  // SilverBullet creates the page on the first edit; navigating there is the
  // whole of "new page".
  await editor.navigate(trimmed);
}

// A pure folder has no object behind it, so it has nothing to delete (and
// deleting a whole subtree is not a job for a hover button). A page that also
// heads a folder keeps its own delete: it has a page to remove.
function isDeletable(obj: TreeObj): boolean {
  return !obj.isFolder || obj.ref != null;
}

export const spaceTreeView: BuiltinView<TreeObj> = {
  meta: baseMeta({
    // vault-web: 日本語にする（label は入力欄の左の見出し。CSS で隠している）
    title: t("ノート一覧", "Notes"),
    label: t("開く", "Open"),
    dock: "lhs",
    supportedDocks: ["lhs", "rhs", "bhs", "modal"],
    mode: "tree",
    followEditor: true,
    hasCreate: true,
    uploadFiles: true,
    foldersFirst: false,
    // vault-web: フォルダを押したら開閉だけにする（中身の一覧のページを開かない）。
    // 同じ名前のノートがあるフォルダは、ノートとして開く
    selectableFolders: false,
    refreshOn: expandRefreshTriggers(["index"]),
  }),
  row: {
    icon: treeIcon,
    priority: (obj) => obj.pageDecoration?.tree?.priority,
  },
  segments: spaceTreeSegments,
  actions: [
    {
      icon: "plus",
      label: "New page here",
      requireMode: "rw",
      when: (obj) => obj.isFolder === true,
      run: newPageUnder,
    },
    { icon: "edit-3", label: "Rename", requireMode: "rw", run: renameTreeRow },
    {
      icon: "trash-2",
      label: "Delete",
      requireMode: "rw",
      when: isDeletable,
      run: deleteTreeRow,
    },
  ],
  keymap: {
    // Peek: open the row without leaving the panel, so the next arrow keeps
    // browsing. `editor.navigate` focuses the editor; the panel takes focus
    // back on its own afterwards.
    " ": (obj) => editor.navigate(obj.ref ?? obj.name),
  },
  onMove: moveByRename,
  source: spaceTreeSource,
  onSelect: (obj) => editor.navigate(obj.ref ?? obj.name),
  onCreate: (name) => editor.navigate(name),
};
