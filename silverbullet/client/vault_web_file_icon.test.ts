import { expect, test } from "vitest";
import { documentIcon } from "./vault_web_file_icon.ts";

test("ファイルの種類ごとにアイコンを出し分ける", () => {
  expect(documentIcon("a/b.png", "image/png")).toBe("image");
  expect(documentIcon("clip.mp4", "video/mp4")).toBe("film");
  expect(documentIcon("voice.m4a", "audio/mp4")).toBe("music");
  expect(documentIcon("data/list.CSV", "text/csv")).toBe("grid");
  expect(documentIcon("無題のファイル.base", "application/octet-stream")).toBe("database");
  expect(documentIcon("rename-map.json", "application/json")).toBe("code");
  expect(documentIcon("images.zip", "application/zip")).toBe("archive");
  expect(documentIcon("doc.pdf", "application/pdf")).toBe("book-open");
  expect(documentIcon("note.txt", "text/plain")).toBe("file");
  expect(documentIcon("NBOX_v1.10.ex5", undefined)).toBe("file");
  expect(documentIcon(".hidden", undefined)).toBe("file");
});
