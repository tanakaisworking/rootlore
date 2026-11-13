import { expect, test } from "vitest";
import { canEditNote, editUrlFor, editWindowFeatures, historyUrlFor } from "./vault_web_edit.ts";

const repo = { owner: "me", repo: "notes", branch: "main" };
const time = "2026-11-03T00:00:00.000Z";

test("opens the GitHub editor for a note in the vault", () => {
  expect(editUrlFor(repo, "日記/2026 11#3?.md", time)).toBe(
    "https://github.com/me/notes/edit/main/%E6%97%A5%E8%A8%98/2026%2011%233%3F.md",
  );
  expect(editUrlFor({ ...repo, branch: "notes/main" }, "a.md", time)).toBe(
    "https://github.com/me/notes/edit/notes/main/a.md",
  );
});

test("pages that are not files in the vault cannot be edited on GitHub", () => {
  // ホーム、「ページが見つかりません」、仮想ページは、その場で作った中身なので日時がない
  expect(editUrlFor(repo, "index.md", "")).toBeUndefined();
  expect(editUrlFor(repo, "index.md", undefined)).toBeUndefined();
  // 同梱のページは vault にない
  expect(editUrlFor(repo, "Library/Std/Rootlore/Home.md", time)).toBeUndefined();
  // ノート以外（画像など）
  expect(editUrlFor(repo, "画像/a.png", time)).toBeUndefined();
});

test("a note deleted on GitHub can still be edited when this browser has its draft", () => {
  const draftFor = (path: string) => path === "日記/消えた.md";
  expect(canEditNote(repo, "日記/a.md", time, () => false)).toBe(true);
  // ファイルがない（日時がない）ノートは、下書きがあるときだけ
  expect(canEditNote(repo, "日記/消えた.md", undefined, draftFor)).toBe(true);
  expect(canEditNote(repo, "日記/ほか.md", undefined, draftFor)).toBe(false);
  // 同梱のページとノート以外は、下書きがあっても直せない
  expect(canEditNote(repo, "Library/Std/Rootlore/Home.md", undefined, () => true)).toBe(false);
  expect(canEditNote(repo, "画像/a.png", undefined, () => true)).toBe(false);
});

test("編集のウィンドウは小さなポップアップにし、今の画面の真ん中に重ねる", () => {
  const big = { screenX: 100, screenY: 50, outerWidth: 1600, outerHeight: 1000, availWidth: 1920, availHeight: 1080 };
  expect(editWindowFeatures(big)).toBe("popup=yes,width=1000,height=800,left=400,top=150");
  // 画面が小さいときは収まる大きさに縮める
  const small = { screenX: 0, screenY: 0, outerWidth: 1280, outerHeight: 720, availWidth: 1280, availHeight: 720 };
  expect(editWindowFeatures(small)).toBe("popup=yes,width=1000,height=640,left=140,top=40");
});

test("a note's history opens GitHub's change list for that file, and only for notes in the vault", () => {
  expect(historyUrlFor(repo, "日記/2026 11#3?.md", time)).toBe(
    "https://github.com/me/notes/commits/main/%E6%97%A5%E8%A8%98/2026%2011%233%3F.md",
  );
  expect(historyUrlFor({ ...repo, branch: "notes/main" }, "a.md", time)).toBe(
    "https://github.com/me/notes/commits/notes/main/a.md",
  );
  expect(historyUrlFor(repo, "index.md", undefined)).toBeUndefined();
  expect(historyUrlFor(repo, "Library/Std/Rootlore/Home.md", time)).toBeUndefined();
});
