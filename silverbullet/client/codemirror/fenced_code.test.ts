import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { expect, test, vi } from "vitest";
import type { Client } from "../client.ts";
import { fencedCodePlugin } from "./fenced_code.ts";
import { MermaidWidget } from "./mermaid_widget.ts";

vi.mock("../components/widget_sandbox_iframe.ts", () => ({}));

function client(darkMode = true, renderWidgets = true): Client {
  return {
    ui: { viewState: { uiOptions: { darkMode } } },
    currentPageMeta: () => ({ pageDecoration: { renderWidgets } }),
    systemReady: true,
    clientSystem: {
      scriptsLoaded: true,
      luaCodeWidgets: new Map(),
      codeWidgetHook: { codeWidgetCallbacks: new Map() },
    },
    fullIndexCompleted: true,
    pageListLoaded: true,
    editorView: { requestMeasure: () => {} },
  } as unknown as Client;
}

function decorations(
  state: EditorState,
  field: ReturnType<typeof fencedCodePlugin>,
): Decoration[] {
  const found: Decoration[] = [];
  state.field(field).between(0, state.doc.length, (_from, _to, decoration) => {
    found.push(decoration);
  });
  return found;
}

function widgets(
  state: EditorState,
  field: ReturnType<typeof fencedCodePlugin>,
): MermaidWidget[] {
  return decorations(state, field)
    .map((decoration) => (decoration.spec as { widget?: unknown }).widget)
    .filter(
      (widget): widget is MermaidWidget => widget instanceof MermaidWidget,
    );
}

test("a mermaid fence becomes one block widget with the current theme", () => {
  const doc = "before\n\n```mermaid\nflowchart LR\nA --> B\n```\n\nafter";
  const field = fencedCodePlugin(client());
  const state = EditorState.create({ doc, extensions: [markdown(), field] });
  const found = decorations(state, field)
    .map((decoration) => (decoration.spec as { widget?: unknown }).widget)
    .filter(
      (widget): widget is MermaidWidget => widget instanceof MermaidWidget,
    );

  expect(found).toHaveLength(1);
  expect(found[0].source).toBe("flowchart LR\nA --> B");
  expect(found[0].dark).toBe(true);
  const widgetDecoration = decorations(state, field).find(
    (decoration) =>
      (decoration.spec as { widget?: unknown }).widget === found[0],
  );
  expect(
    (widgetDecoration?.spec as { block?: boolean } | undefined)?.block,
  ).toBe(true);
});

test("the source stays visible while the cursor is inside the fence", () => {
  const doc = "```mermaid\nflowchart LR\nA --> B\n```";
  const field = fencedCodePlugin(client());
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.indexOf("flowchart") + 1 },
    extensions: [markdown(), field],
  });
  expect(widgets(state, field)).toHaveLength(0);
});

test("renderWidgets false leaves the mermaid source alone", () => {
  const doc = "```mermaid\nflowchart LR\nA --> B\n```";
  const field = fencedCodePlugin(client(true, false));
  const state = EditorState.create({
    doc,
    extensions: [markdown(), field],
  });
  expect(widgets(state, field)).toHaveLength(0);
});
