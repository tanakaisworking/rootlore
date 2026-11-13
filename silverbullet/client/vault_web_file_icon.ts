// vault-web: ファイル一覧とノートの検索で、ファイルの種類ごとにアイコンを出し分ける（Feather のアイコン名）。
// 元は読み取り専用のものに鍵を出すが、vault-web はすべて読み取り専用なので全部が鍵になる。鍵は出さない

const byExtension: Record<string, string> = {
  csv: "grid",
  tsv: "grid",
  xls: "grid",
  xlsx: "grid",
  base: "database",
  json: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  xml: "code",
  html: "code",
  css: "code",
  js: "code",
  ts: "code",
  py: "code",
  sh: "code",
  sql: "code",
  lua: "code",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  tar: "archive",
  "7z": "archive",
  rar: "archive",
  pdf: "book-open",
};

/** ノートでないファイル（tag が document）のアイコン。種類（contentType）を先に見て、なければ拡張子で決める */
export function documentIcon(name: string, contentType?: unknown): string {
  const type = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "film";
  if (type.startsWith("audio/")) return "music";
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return byExtension[extension] ?? "file";
}
