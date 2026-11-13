// vault-web: フォルダのページ。左のツリーでフォルダを押すと、フォルダと同じ名前のページを開く（元の動き）。
// 元は書き込める前提で空の新しいページになるが、読み取り専用の vault-web では「見つかりません」になってしまう。
// ページがなく、その名前のフォルダがあるときは、content_manager.ts がこの一覧を中身にする。

import { escapeInline } from "./vault_web_home.ts";
import { t } from "./vault_web_i18n.ts";

const collator = new Intl.Collator("ja", { numeric: true });

function hidden(name: string): boolean {
  return name.split("/").some((part) => part.startsWith("."));
}

/** フォルダの直下にあるもの。フォルダでなければ undefined */
export function renderFolderPage(
  folder: string,
  fileNames: Iterable<string>,
): string | undefined {
  const prefix = `${folder}/`;
  const subfolders = new Map<string, number>();
  const notes: string[] = [];
  const files: string[] = [];
  for (const name of fileNames) {
    if (!name.startsWith(prefix) || hidden(name.slice(prefix.length))) continue;
    const rest = name.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const sub = rest.slice(0, slash);
      subfolders.set(sub, (subfolders.get(sub) ?? 0) + 1);
    } else if (rest.endsWith(".md")) {
      notes.push(rest.slice(0, -3));
    } else {
      files.push(rest);
    }
  }
  if (subfolders.size === 0 && notes.length === 0 && files.length === 0) {
    return undefined;
  }

  const base = folder.slice(folder.lastIndexOf("/") + 1);
  const link = (target: string, label: string) =>
    `[[${prefix}${target}|${escapeInline(label)}]]`;
  const lines = [`# ${escapeInline(base)}`, ""];
  if (folder.includes("/")) lines.push(escapeInline(folder), "");

  if (subfolders.size > 0) {
    lines.push(`## ${t("フォルダ", "Folders")}`, "");
    for (const sub of [...subfolders.keys()].sort(collator.compare)) {
      const count = subfolders.get(sub)!;
      lines.push(
        `- ${link(sub, sub)}${t(`（${count}件）`, ` (${count} ${count === 1 ? "file" : "files"})`)}`,
      );
    }
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push(`## ${t("ノート", "Notes")}`, "");
    for (const note of notes.sort(collator.compare)) lines.push(`- ${link(note, note)}`);
    lines.push("");
  }
  if (files.length > 0) {
    lines.push(`## ${t("その他のファイル", "Other files")}`, "");
    for (const file of files.sort(collator.compare)) lines.push(`- ${link(file, file)}`);
    lines.push("");
  }
  return lines.join("\n");
}
