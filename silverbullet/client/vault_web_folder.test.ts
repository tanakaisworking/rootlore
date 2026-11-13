import { expect, test } from "vitest";
import { renderFolderPage } from "./vault_web_folder.ts";

const files = [
  "0_AgentBrain/Knowledge/decisions.md",
  "0_AgentBrain/Knowledge/mistakes.md",
  "0_AgentBrain/Knowledge/Old/2025.md",
  "0_AgentBrain/Knowledge/Old/2024.md",
  "0_AgentBrain/Knowledge/diagram.png",
  "0_AgentBrain/Knowledge/.obsidian/app.json",
  "0_AgentBrain/Knowledgebase.md",
  "Other/note.md",
];

test("フォルダの直下を、フォルダ・ノート・その他のファイルに分けて並べる", () => {
  const text = renderFolderPage("0_AgentBrain/Knowledge", files)!;
  expect(text).toBe(
    [
      "# Knowledge",
      "",
      "0_AgentBrain/Knowledge",
      "",
      "## フォルダ",
      "",
      "- [[0_AgentBrain/Knowledge/Old|Old]]（2件）",
      "",
      "## ノート",
      "",
      "- [[0_AgentBrain/Knowledge/decisions|decisions]]",
      "- [[0_AgentBrain/Knowledge/mistakes|mistakes]]",
      "",
      "## その他のファイル",
      "",
      "- [[0_AgentBrain/Knowledge/diagram.png|diagram.png]]",
      "",
    ].join("\n"),
  );
});

test("一番上のフォルダでは、場所の行を出さない", () => {
  const text = renderFolderPage("Other", files)!;
  expect(text.startsWith("# Other\n\n## ノート")).toBe(true);
});

test("フォルダでなければ undefined（名前が前方一致するだけのノートは数えない）", () => {
  expect(renderFolderPage("0_AgentBrain/Know", files)).toBeUndefined();
  expect(renderFolderPage("Missing", files)).toBeUndefined();
});

test("隠しフォルダの中身だけなら、フォルダとして扱わない", () => {
  expect(renderFolderPage("A", ["A/.obsidian/app.json"])).toBeUndefined();
});
