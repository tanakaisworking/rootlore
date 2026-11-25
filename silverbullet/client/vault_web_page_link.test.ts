import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseToRef } from "@silverbulletmd/silverbullet/lib/ref";

// rootlore link（CLI）と Mac アプリが「リンクで開ける」と決めた名前（cli/src/linkable.rs）は、
// 画面が URL の /v/<名前> から読んだときに、そのノート1つにならなければいけない。
// ならない名前を通すと、リンクが別のページを開く。例は CLI のテストと同じファイル
const cases = readFileSync(new URL("../../cli/src/linkable_cases.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.startsWith("ok\t"))
  .map((line) => line.slice(3));

test("a note the link rule accepts is read from its URL as that one note", () => {
  expect(cases.length).toBeGreaterThan(10);
  for (const path of cases) {
    // CLI とアプリは、.md を取った名前を区切りごとに % で包んで /v/ の後ろに置く
    const inUrl = path.slice(0, -".md".length).split("/").map(encodeURIComponent).join("/");
    // 画面の読み方（client/navigator.ts の parseRefFromURI）
    expect(parseToRef(decodeURIComponent(inUrl)), path).toEqual({ path });
  }
});
