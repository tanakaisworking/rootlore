import { Annotation } from "@codemirror/state";

/**
 * カーソルをアプリが置いたこと（ページを開いたときの本文の先頭、前回の位置、見出しへの移動）。
 * 読むだけの画面では、これを「カーソルを置いた」と数えない（codemirror/util.ts の readOnlyCursorActive）。
 * 数えると、開いただけで最初の見出しの `##` が出る。
 * content_manager.ts から util.ts を読み込むと読み込みが循環して起動が止まるので、依存のないこのファイルに置く
 */
export const programmaticSelection = Annotation.define<boolean>();
