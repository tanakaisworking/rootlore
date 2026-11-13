import { expect, test } from "vitest";
import { buildKnowledgeMap, knowledgeMapNodeRadius } from "./vault_web_knowledge_map.ts";

test("dots remain visible and connected notes stand out when fitting thousands of notes", () => {
  for (const scale of [0.005, 0.05, 0.5, 1, 4]) {
    expect(knowledgeMapNodeRadius(0, scale) * scale).toBeGreaterThanOrEqual(1.5);
    expect(knowledgeMapNodeRadius(1, scale) * scale).toBeGreaterThanOrEqual(2.5);
    expect(knowledgeMapNodeRadius(9, scale)).toBeGreaterThanOrEqual(Math.sqrt(10) * 3);
  }
});

const page = (name: string, tags: string[] = ["page"]) => ({ name, tags });
const link = (from: string, to: string, kind = "link") => ({ page: from, to, toTag: "page", kind });

test("connects notes, resolving short links by note name", () => {
  const { nodes, links } = buildKnowledgeMap(
    [page("Projects/plan"), page("Ideas/plan"), page("Projects/goal"), page("inbox")],
    [
      link("inbox", "goal"), // 名前が1つだけ → Projects/goal
      link("inbox", "plan"), // 名前が2つ → つながない
      link("inbox", "Projects/plan#見出し"),
    ],
  );
  expect(links).toEqual([
    { source: "inbox", target: "Projects/goal" },
    { source: "inbox", target: "Projects/plan" },
  ]);
  expect(nodes.find((n) => n.id === "inbox")).toEqual({ id: "inbox", label: "inbox", degree: 2 });
  expect(nodes.find((n) => n.id === "Ideas/plan")!.degree).toBe(0);
});

test("counts a link in both directions once and ignores self links and co-mentions", () => {
  const { links } = buildKnowledgeMap(
    [page("a"), page("b")],
    [link("a", "b"), link("b", "a"), link("a", "a"), link("a", "b", "co-mention")],
  );
  expect(links).toHaveLength(1);
});

test("leaves out bundled pages, templates, meta pages and links to files", () => {
  const { nodes, links } = buildKnowledgeMap(
    [page("a"), page("Library/Std/Config"), page("tpl", ["template"]), page("m", ["meta/x"])],
    [link("a", "Library/Std/Config"), link("a", "tpl"), { page: "a", to: "img.png", toTag: "document", kind: "link" }],
  );
  expect(nodes.map((n) => n.id)).toEqual(["a"]);
  expect(links).toEqual([]);
});
