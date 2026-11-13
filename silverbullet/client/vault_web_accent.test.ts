import { expect, test } from "vitest";
import {
  accentVariables,
  applyAccent,
  contrast,
  defaultAccent,
  readAccent,
} from "./vault_web_accent.ts";

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

test("残していなければ、または変な値なら標準の紫", () => {
  expect(readAccent({ getItem: () => null })).toBe(defaultAccent);
  expect(readAccent({ getItem: () => "red" })).toBe(defaultAccent);
  expect(readAccent({ getItem: () => "#16A34A" })).toBe("#16a34a");
});

test("標準の紫なら変数を置かない（scss の色をそのまま使う）", () => {
  expect(accentVariables(defaultAccent)).toEqual({});
});

test("文字の色は、ライトでもダークでも背景の上で読める濃さにする", () => {
  for (const color of ["#facc15", "#3b82f6", "#16a34a", "#111111", "#f5f5f5"]) {
    const v = accentVariables(color);
    expect(contrast(rgb(v["--vw-accent-text-light"]!), [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(v["--vw-accent-text-dark"]!), [30, 30, 30])).toBeGreaterThanOrEqual(4.5);
  }
});

test("明るい色のボタンの文字は黒、濃い色なら白", () => {
  expect(accentVariables("#facc15")["--vw-accent-contrast"]).toBe("#000");
  expect(accentVariables("#1d4ed8")["--vw-accent-contrast"]).toBe("#fff");
});

test("色を当て、標準に戻したら変数を消す", () => {
  const props = new Map<string, string>();
  const el = {
    style: {
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
      getPropertyValue: (name: string) => props.get(name) ?? "",
    },
  } as unknown as HTMLElement;
  applyAccent("#16a34a", el);
  expect(el.style.getPropertyValue("--vw-accent")).toBe("#16a34a");
  expect(el.style.getPropertyValue("--vw-accent-rgb")).toBe("22, 163, 74");
  applyAccent(defaultAccent, el);
  expect(el.style.getPropertyValue("--vw-accent")).toBe("");
  expect(el.style.getPropertyValue("--vw-accent-text-light")).toBe("");
});
