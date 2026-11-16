import { expect, test } from "vitest";
import { copyablePath } from "./vault_web_copy_path.ts";

test("notes and other files copy their path in the vault; folders end with a slash", () => {
  expect(copyablePath("0_AgentBrain/Projects/rootlore/index.md", { appPage: false })).toBe("0_AgentBrain/Projects/rootlore/index.md");
  expect(copyablePath("Notes/table.base", { appPage: false })).toBe("Notes/table.base");
  expect(copyablePath("0_AgentBrain/Projects.md", { appPage: false, folderShown: "0_AgentBrain/Projects" })).toBe("0_AgentBrain/Projects/");
});

test("pages that are not files in the vault have nothing to copy", () => {
  expect(copyablePath("Library/Std/Rootlore/設定.md", { appPage: true })).toBeUndefined();
  expect(copyablePath("Library/Std/Rootlore/Demo/ja/はじめに.md", { appPage: false })).toBeUndefined();
  expect(copyablePath("index.md", { appPage: false, homeShown: "index" })).toBeUndefined();
  expect(copyablePath("Gone.md", { appPage: false, missingShown: "Gone" })).toBeUndefined();
  expect(copyablePath(undefined, { appPage: false })).toBeUndefined();
});
