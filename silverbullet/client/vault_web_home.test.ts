import { expect, test } from "vitest";
import { escapeInline, renderHome } from "./vault_web_home.ts";

const commit = (files: { filename: string; status: string }[], message = "AI: update notes") => ({
  sha: "a".repeat(40),
  commit: { message, author: { name: "bot", date: "2026-11-02T09:00:00Z" } },
  files,
});

test("lists changed notes as links, with deleted notes as plain text", () => {
  const md = renderHome([
    commit([
      { filename: "Projects/plan.md", status: "modified" },
      { filename: "old.md", status: "removed" },
      { filename: "img/a.png", status: "added" },
    ]),
  ]);
  expect(md).toContain("## 最近の更新");
  expect(md).toContain("- [[Projects/plan|plan]]（変更） · Projects");
  expect(md).toContain("- ~~old~~（削除）");
  expect(md).toContain("ノート以外のファイル 1件");
});

test("says there is more when the file list was cut", () => {
  const files = Array.from({ length: 13 }, (_, i) => ({ filename: `n${i}.md`, status: "added" }));
  const md = renderHome([commit(files)]);
  expect(md).not.toContain("[[n12|");
  expect(md).toContain("ほかの変更は省略");
});

test("commit messages cannot inject links or html", () => {
  const md = renderHome([commit([], "see [[secret]] <img src=x> `code`")]);
  expect(md).not.toContain("[[secret]]");
  expect(md).toContain("\\<img");
  expect(escapeInline("a*b")).toBe("a\\*b");
});
