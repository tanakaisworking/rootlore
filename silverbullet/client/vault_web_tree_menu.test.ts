import { expect, test } from "vitest";
import { treeMenuActions } from "./vault_web_tree_menu.ts";

test("a note offers open, rename, copy path, new note in its folder, and delete", () => {
  expect(treeMenuActions({ name: "Projects/a", tag: "page" })).toEqual([
    { kind: "open", path: "Projects/a.md" },
    { kind: "rename-file", path: "Projects/a.md" },
    { kind: "copy-path", path: "Projects/a.md" },
    { kind: "new-note", folder: "Projects/" },
    { kind: "delete", path: "Projects/a.md" },
  ]);
});

test("a file keeps its own extension, and a top-level file creates notes at the top", () => {
  const actions = treeMenuActions({ name: "table.base", tag: "document" });
  expect(actions[0]).toEqual({ kind: "open", path: "table.base" });
  expect(actions).toContainEqual({ kind: "new-note", folder: "" });
});

test("a folder offers new note inside, rename, and copy path, but no delete", () => {
  expect(treeMenuActions({ name: "Projects/rootlore", isFolder: true })).toEqual([
    { kind: "new-note", folder: "Projects/rootlore/" },
    { kind: "rename-folder", folder: "Projects/rootlore" },
    { kind: "copy-path", path: "Projects/rootlore/" },
  ]);
});

test("a folder that is also a note acts on the note but is not renamed, so the pair stays together", () => {
  const actions = treeMenuActions({ name: "Projects", isFolder: true, ref: "Projects", tag: "page" });
  expect(actions.map((a) => a.kind)).toEqual(["open", "copy-path", "new-note", "delete"]);
  expect(actions).toContainEqual({ kind: "new-note", folder: "Projects/" });
});

test("bundled app pages get no menu", () => {
  expect(treeMenuActions({ name: "Library/Std/Rootlore/Home", tag: "page" })).toEqual([]);
});
