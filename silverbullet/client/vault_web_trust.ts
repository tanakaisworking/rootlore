// vault-web: Lua を動かしてよいのは、アプリに同梱した標準ライブラリだけ。
// vault（GitHub のノート）は AI も書き込むので、そこに書かれた Lua は実行しない。
// Lua からは js.import / js.window で任意の JavaScript を動かせるため。
// vault 側の Library/Std/ は GitHubSpacePrimitives が読まないので、この接頭辞は同梱分だけを指す。
// 判定に使う名前は、ノートに書けるもの（object の ref、ページのメタデータの name）ではなく、実際のパスにする。

import { Facet } from "@codemirror/state";

const trustedPrefix = "Library/Std/";

// エディターの中身がどのページのものか。中身と一緒に createEditorState で決める（lua_directive.ts で使う）。
// ページを切り替える途中は currentName() だけが先に変わり、エディターには前のノートの中身が残っているため
export const luaDirectivePageName = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

// 同梱でも、vault のノートをテンプレートとして（中の ${...} を Lua として）評価する仕組みは動かさない。
// テンプレートのコマンドは既存のコマンドを上書きもできる。ページを作る機能なので、読み取り専用の今は要らない
const untrustedStdPages = new Set([
  "Library/Std/Infrastructure/Page Templates",
  "Library/Std/Infrastructure/Slash Templates",
]);

/** ページ名（"Library/Std/APIs/DOM" など）や script.ref（"…@123"）が、動かしてよい同梱の標準ライブラリか */
export function isTrustedLuaSource(refOrPage: string | undefined): boolean {
  if (!refOrPage || !refOrPage.startsWith(trustedPrefix)) return false;
  return !untrustedStdPages.has(refOrPage.replace(/@\d+$/, ""));
}
