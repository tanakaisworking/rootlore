import { expect, test, vi } from "vitest";
import { isTrustedLuaSource, luaDirectivePageName } from "./vault_web_trust.ts";

// 画面（document）が要る部品の代わり。このテストでは描くかどうかだけを見る
vi.mock("./codemirror/lua_widget.ts", async () => {
  const { WidgetType } = await import("@codemirror/view");
  return { LuaWidget: class extends WidgetType { toDOM(): HTMLElement { throw new Error("unused"); } } };
});
vi.mock("./codemirror/loading_widget.ts", async () => {
  const { WidgetType } = await import("@codemirror/view");
  return { LoadingWidget: class extends WidgetType { toDOM(): HTMLElement { throw new Error("unused"); } } };
});
import { expandMarkdown } from "./markdown_renderer/inline.ts";
import { parse } from "./markdown_parser/parse_tree.ts";
import { extendedMarkdownLanguage } from "./markdown_parser/parser.ts";
import { renderToText } from "../plug-api/lib/tree.ts";
import { LuaEnv } from "./space_lua/runtime.ts";
import { luaBuildStandardEnv } from "./space_lua/stdlib.ts";
import type { SpaceLuaEnvironment } from "./space_lua.ts";
import type { Space } from "./space.ts";

test("only the bundled standard library is trusted to run Lua", () => {
  expect(isTrustedLuaSource("Library/Std/APIs/DOM@120")).toBe(true);
  expect(isTrustedLuaSource("Library/Std/Pages/Index")).toBe(true);
  expect(isTrustedLuaSource("Daily/2026-11-02@5")).toBe(false);
  expect(isTrustedLuaSource("Library/Stdx/evil")).toBe(false);
  expect(isTrustedLuaSource("library/std/evil")).toBe(false);
  expect(isTrustedLuaSource(undefined)).toBe(false);
  // vault のノートをテンプレートとして評価する仕組みは、同梱でも動かさない
  expect(isTrustedLuaSource("Library/Std/Infrastructure/Page Templates")).toBe(false);
  expect(isTrustedLuaSource("Library/Std/Infrastructure/Page Templates@153")).toBe(false);
  expect(isTrustedLuaSource("Library/Std/Infrastructure/Slash Templates@54")).toBe(false);
  expect(isTrustedLuaSource("Library/Std/Infrastructure/Query Templates@1")).toBe(true);
});

async function expand(pageName: string) {
  const env = new LuaEnv(luaBuildStandardEnv());
  const tree = await expandMarkdown(
    {} as Space,
    pageName,
    parse(extendedMarkdownLanguage, "${1 + 1}"),
    { env } as SpaceLuaEnvironment,
    { expandLuaDirectives: true },
  );
  return renderToText(tree);
}

// 埋め込み、表、一覧、ウィジェットの出力はすべて expandMarkdown を通る。ここでは何も実行しない
test("expandMarkdown never runs Lua directives, whatever the page or options", async () => {
  expect(await expand("Notes/Hello")).toBe("${1 + 1}");
  expect(await expand("Library/Std/Pages/Hello")).toBe("${1 + 1}");
});

test("space-lua runs only from Library/Std pages, whatever ref the object claims", async () => {
  const { SpaceLuaEnvironment } = await import("./space_lua.ts");
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
  });
  const rows = [
    {
      page: "Library/Std/Real",
      value: { ref: "Library/Std/Real@0", script: "fromStd = true" },
    },
    {
      // data ブロックで ref を偽ったノート
      page: "Notes/Evil",
      value: { ref: "Library/Std/Injected@0", script: "fromVault = true" },
    },
  ];
  const lua = new SpaceLuaEnvironment(
    { registeredSyscalls: new Map() } as any,
    { objectsWithPage: async () => rows } as any,
  );
  await lua.reload();
  expect(lua.env.get("fromStd")).toBe(true);
  expect(lua.env.get("fromVault")).toBeNull();
  vi.unstubAllGlobals();
});

// ページの切り替え中は、開いているパスが先に同梱ページに変わり、エディターにはまだ前のノートの中身が残る
test("the editor draws ${...} only when its own text came from a standard library page", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { buildExtendedMarkdownLanguage } = await import("./markdown_parser/parser.ts");
  const { luaDirectivePlugin } = await import("./codemirror/lua_directive.ts");
  const client = {
    currentName: () => "Library/Std/Pages/Space Overview",
    currentPageMeta: () => undefined,
    systemReady: false, // "loading" のまま。実行せずに、描くかどうかだけを見る
    ui: { viewState: { uiOptions: { markdownSyntaxRendering: false } } },
  };
  const count = (textPage: string) => {
    const plugin = luaDirectivePlugin(client as any);
    const state = EditorState.create({
      doc: "x ${1 + 1}",
      selection: { anchor: 0 },
      extensions: [buildExtendedMarkdownLanguage(), luaDirectivePageName.of(textPage), plugin],
    });
    return state.field(plugin).size;
  };
  expect(count("Library/Std/Pages/Space Overview")).toBeGreaterThan(0);
  expect(count("Notes/Evil")).toBe(0);
  expect(count("")).toBe(0);
});

test("markdown.expandMarkdown from Lua leaves ${...} as text, even on a standard library page", async () => {
  const { markdownSyscalls } = await import("./plugos/syscalls/markdown.ts");
  const env = new LuaEnv(luaBuildStandardEnv());
  const client = {
    space: {},
    currentName: () => "Library/Std/Pages/Space Overview",
    config: { get: (_key: string, fallback: unknown) => fallback },
    clientSystem: { spaceLuaEnv: { env } },
  };
  const expand = (markdownSyscalls(client as any)["markdown.expandMarkdown"] as any).callback;
  expect(await expand({} as any, "x ${1 + 1}", { expandLuaDirectives: true })).toBe("x ${1 + 1}");
});
