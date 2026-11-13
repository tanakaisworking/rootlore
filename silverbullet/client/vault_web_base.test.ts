import { describe, expect, test } from "vitest";
import {
  BaseParseError,
  type BaseRow,
  buildTable,
  cellText,
  evaluate,
  formatValue,
  parseBase,
  parseExpression,
  rowFromPage,
  UnsupportedError,
} from "./vault_web_base.ts";

function row(name: string, extra: Partial<BaseRow> = {}): BaseRow {
  return { name, props: {}, tags: [], links: [], ...extra };
}

const rows: BaseRow[] = [
  row("Projects/Alpha", { tags: ["project", "work/active"], props: { status: "active", priority: 2, due: "2026-11-20" }, links: ["Meetings/Kickoff"] }),
  row("Projects/Beta", { tags: ["project"], props: { status: "done", priority: 1 } }),
  row("Meetings/Kickoff", { tags: ["meeting"], props: { date: "2026-11-01" } }),
  row("Inbox", { tags: [], props: {} }),
];

const names = (base: string, view = 0) => {
  const file = parseBase(base);
  return buildTable(file, file.views[view]!, rows).groups.flatMap((g) => g.rows.map((r) => r.name));
};

describe("expressions", () => {
  test("compares frontmatter values with note. and bare names", () => {
    expect(evaluate(parseExpression('status == "active"'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('note.status != "active"'), rows[1]!)).toBe(true);
    expect(evaluate(parseExpression("priority >= 2 && status == 'active'"), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression("!(priority > 1) || status == 'x'"), rows[0]!)).toBe(false);
  });

  test("compares dates", () => {
    expect(evaluate(parseExpression('date(due) < date("2026-12-01")'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('date(due) > date("2026-12-01")'), rows[0]!)).toBe(false);
  });

  test("file functions", () => {
    expect(evaluate(parseExpression('file.hasTag("work")'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.hasTag("#work/active")'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.hasTag("wor")'), rows[0]!)).toBe(false);
    expect(evaluate(parseExpression('file.hasTag("x", "meeting")'), rows[2]!)).toBe(true);
    expect(evaluate(parseExpression('file.inFolder("Projects")'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.inFolder("Proj")'), rows[0]!)).toBe(false);
    expect(evaluate(parseExpression('file.hasLink("Kickoff")'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.hasLink("[[Meetings/Kickoff]]")'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.hasProperty("due")'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.hasProperty("due")'), rows[1]!)).toBe(false);
  });

  test("file properties", () => {
    expect(evaluate(parseExpression('file.folder == "Projects"'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.name == "Alpha.md"'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('file.basename == "Alpha"'), rows[0]!)).toBe(true);
    expect(evaluate(parseExpression('tags == "project"'), rows[1]!)).toBe(true);
  });

  test("unsupported syntax is reported, not evaluated", () => {
    expect(() => parseExpression("status.lower() == 'x'")).toThrow(UnsupportedError);
    expect(() => parseExpression("formula.score > 1")).toThrow(UnsupportedError);
    expect(() => parseExpression("priority + 1 > 2")).toThrow(UnsupportedError);
    expect(() => parseExpression("this.file.name == 'x'")).toThrow(UnsupportedError);
    expect(() => parseExpression("file.backlinks")).toThrow(UnsupportedError);
    expect(() => parseExpression('status == "open')).toThrow(SyntaxError);
  });
});

describe("filters", () => {
  test("combines global and view filters", () => {
    const base = `
filters:
  and:
    - file.inFolder("Projects")
views:
  - type: table
    name: Active
    filters:
      and:
        - 'status == "active"'
  - type: table
    name: All projects
`;
    expect(names(base, 0)).toEqual(["Projects/Alpha"]);
    expect(names(base, 1)).toEqual(["Projects/Alpha", "Projects/Beta"]);
  });

  test("or and not", () => {
    expect(names(`
filters:
  or:
    - file.hasTag("meeting")
    - 'status == "done"'
`)).toEqual(["Projects/Beta", "Meetings/Kickoff"]);
    expect(names(`
filters:
  not:
    - file.hasTag("project")
    - file.hasTag("meeting")
`)).toEqual(["Inbox"]);
  });

  test("an unsupported condition is skipped and listed", () => {
    const file = parseBase(`
filters:
  and:
    - file.inFolder("Projects")
    - 'formula.score > 3'
formulas:
  score: 'priority * 2'
summaries:
  x: y
views:
  - type: cards
    name: Board
    order: [file.name, formula.score]
`);
    expect(file.unsupported.length).toBeGreaterThanOrEqual(3);
    expect(file.views[0]!.unsupported.some((u) => u.includes("formula.score"))).toBe(true);
    const table = buildTable(file, file.views[0]!, rows);
    expect(table.groups[0]!.rows.map((r) => r.name)).toEqual(["Projects/Alpha", "Projects/Beta"]);
    expect(cellText(table.groups[0]!.rows[0]!, "formula.score")).toBe("");
  });
});

describe("views", () => {
  test("defaults to one table view with the note name", () => {
    const file = parseBase("");
    expect(file.views).toHaveLength(1);
    expect(file.views[0]!.order).toEqual(["file.name"]);
    expect(buildTable(file, file.views[0]!, rows).total).toBe(4);
  });

  test("order, display names, sort, limit, group", () => {
    const file = parseBase(`
properties:
  note.status:
    displayName: State
views:
  - type: table
    name: T
    order: [file.name, status, priority]
    sort:
      - property: priority
        direction: DESC
    limit: 1
  - type: table
    name: G
    filters:
      and:
        - file.hasTag("project")
    groupBy:
      property: status
      direction: ASC
`);
    const table = buildTable(file, file.views[0]!, rows);
    expect(table.columns.map((c) => c.label).slice(1)).toEqual(["State", "priority"]);
    expect(table.total).toBe(4);
    expect(table.groups[0]!.rows.map((r) => r.name)).toEqual(["Projects/Alpha"]);
    const grouped = buildTable(file, file.views[1]!, rows);
    expect(grouped.groups.map((g) => g.label)).toEqual(["active", "done"]);
  });

  test("broken YAML throws a parse error", () => {
    expect(() => parseBase("views: [")).toThrow(BaseParseError);
    expect(() => parseBase("- a\n- b")).toThrow(BaseParseError);
  });
});

describe("rows and cells", () => {
  test("builds a row from an index page", () => {
    const r = rowFromPage(
      { name: "Demo/Plan", tags: ["demo"], lastModified: "2026-11-07T10:00:00Z", status: "open", ref: "Demo/Plan", tag: "page" },
      new Map([["Demo/Plan", ["Demo/Notes"]]]),
    )!;
    expect(r.props).toEqual({ status: "open" });
    expect(r.tags).toEqual(["demo"]);
    expect(r.links).toEqual(["Demo/Notes"]);
    expect(r.mtime?.toISOString()).toBe("2026-11-07T10:00:00.000Z");
    expect(cellText(r, "file.name")).toBe("Plan");
  });

  test("formats values", () => {
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue("see [[Demo/Notes]] and [[X|alias]]")).toBe("see Notes and alias");
    expect(formatValue(new Date(2026, 10, 7))).toBe("2026-11-07");
    expect(formatValue(null)).toBe("");
    expect(formatValue(true)).toBe("true");
  });
});

describe("review fixes", () => {
  test("date-only strings are local midnight, like today()", () => {
    const now = new Date();
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const r = row("Task", { props: { due: ymd } });
    expect(evaluate(parseExpression("date(due) <= today()"), r)).toBe(true);
    expect(evaluate(parseExpression("date(due) >= today()"), r)).toBe(true);
    // YAML の日付（UTC の 0 時の Date）も、その日として扱う
    const yaml = row("Y", { props: { due: new Date(Date.UTC(2026, 10, 7)) } });
    expect(formatValue(yaml.props.due)).toBe("2026-11-07");
    expect(evaluate(parseExpression('due == date("2026-11-07")'), yaml)).toBe(true);
  });

  test("dotted frontmatter keys are read from nested values", () => {
    const r = row("N", { props: { project: { status: "active" } } });
    expect(evaluate(parseExpression('project.status == "active"'), r)).toBe(true);
    expect(evaluate(parseExpression('file.hasProperty("project.status")'), r)).toBe(true);
    expect(cellText(r, "note.project.status")).toBe("active");
  });

  test("an empty or matches nothing", () => {
    expect(names("filters:\n  or: []\n")).toEqual([]);
  });
});
