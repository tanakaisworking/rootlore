import { expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { isCursorInRange, readOnlyCursorActive } from "./codemirror/util.ts";
import { programmaticSelection } from "./codemirror/vault_web_programmatic_selection.ts";

// 読むだけの画面。本文の先頭は "# Title" の行（4 文字目から）
const doc = "---\na: 1\n---\n# Title\nbody";
const heading: [number, number] = [14, 21];
const readOnly = () =>
  EditorState.create({ doc, extensions: [EditorState.readOnly.of(true), readOnlyCursorActive] });

test("a cursor the app places on open does not reveal heading markup", () => {
  const state = readOnly().update({ selection: { anchor: 14 }, annotations: programmaticSelection.of(true) }).state;
  expect(isCursorInRange(state, heading)).toBe(false);
});

test("a cursor the reader moves still reveals the markup under it", () => {
  const opened = readOnly().update({ selection: { anchor: 14 }, annotations: programmaticSelection.of(true) }).state;
  const clicked = opened.update({ selection: { anchor: 16 } }).state;
  expect(isCursorInRange(clicked, heading)).toBe(true);
});

test("a state created with the cursor already on the heading does not reveal it", () => {
  const state = EditorState.create({
    doc,
    selection: { anchor: 14 },
    extensions: [EditorState.readOnly.of(true), readOnlyCursorActive],
  });
  expect(isCursorInRange(state, heading)).toBe(false);
});
