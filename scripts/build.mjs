// SilverBullet のビルド成果物（silverbullet/client_bundle）を、Worker の静的ファイル（dist/）に並べ直す。
// 先に `npm --prefix silverbullet run build` を済ませておく。
//
// dist/
//   index.html          SilverBullet の画面の入口（テンプレートの変数を埋めたもの）
//   service_worker.js   ノートの同期と /.fs への応答
//   .client/            画面の JS・CSS・フォント
//   _base_fs/           同梱する標準ライブラリ（Library/Std）と、その一覧 manifest.json

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "silverbullet/client_bundle");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(join(bundle, "client/.client"), join(dist, ".client"), { recursive: true });
for (const file of ["service_worker.js", "service_worker.js.map"]) {
  await cp(join(bundle, "client", file), join(dist, file));
}
await cp(join(bundle, "base_fs"), join(dist, "_base_fs"), { recursive: true });

// index.html は SilverBullet のサーバーが minijinja で埋めるテンプレート。ここで固定の値を入れる
const template = await readFile(join(bundle, "client/.client/index.html"), "utf8");
const values = {
  // 画面は /v/ の下に置く（LP は根に別の Worker がある）。<base href> と、画面の中の相対パスがこれで決まる
  host_prefix: "/v",
  // 製品名（2026-11-05 に決めた）。ノートを開くと、タブ名はノートの名前になる
  title: "Rootlore",
  description: "GitHubのMarkdownノートを、ブラウザだけで読んで直せるアプリ。",
  // リンクを貼ったときの絵（1200x630）。SNSのカードで使う
  image: "https://rootlore.app/v/.client/og-image.png",
  content: "",
  additional_head_html: "",
};
const html = template
  .replace(/\{%\s*if[\s\S]*?\{%\s*endif\s*%\}/g, "")
  .replace(/\{\{\s*(\w+)(?:\s*\|\s*safe)?\s*\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`index.html: unknown template variable ${key}`);
    return values[key];
  });
await writeFile(join(dist, "index.html"), html);
await rm(join(dist, ".client/index.html"));

// アプリとしてホーム画面に追加するときの情報。SilverBullet ではサーバーがその場で作る
// （server/src/handlers/control.rs の handle_manifest）ので、ここで同じ形のものを置く。
// 置かないと index.html が返り、ブラウザが「Manifest: Syntax error」を出す。
// 保存はまだできないので、共有から受け取る share_target は入れない
const appManifest = {
  short_name: values.title,
  name: values.title,
  icons: [
    { src: "/v/.client/logo.png", type: "image/png", sizes: "512x512" },
    { src: "/v/.client/logo-dock.png", type: "image/png", sizes: "1024x1024" },
  ],
  capture_links: "new-client",
  start_url: "/v/#boot",
  display: "standalone",
  display_override: ["window-controls-overlay"],
  scope: "/v/",
  theme_color: "#e1e1e1",
  description: values.description,
};
await writeFile(join(dist, ".client/manifest.json"), `${JSON.stringify(appManifest, null, 2)}\n`);

// 外へ送る・外から読み込む道を塞ぐ。GitHub へは Worker の /api/gh を通すので 'self' だけでよい。
// ノートの外部画像も読まない（画像の URL に中身を載せて送れるため）。
// index.html の中に直接書かれた <script> は、その中身のハッシュで許す
const inlineScriptHashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  ([, body]) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`,
);
const csp = [
  "default-src 'self'",
  `script-src 'self' ${inlineScriptHashes.join(" ")}`,
  // CodeMirror などが style 属性と <style> を使う
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
// Workers の静的ファイルは _headers を読む（_headers 自体は配られない）
await writeFile(
  join(dist, "_headers"),
  `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`,
);

// 標準ライブラリの一覧。GitHubSpacePrimitives がノートの一覧に読み取り専用で重ねる
const contentTypes = { md: "text/markdown", js: "application/javascript", base: "application/yaml" };
const base = join(dist, "_base_fs");
const manifest = [];
for (const path of await listFiles(base)) {
  const name = relative(base, path);
  const ext = name.split(".").pop();
  if (!(ext in contentTypes)) continue;
  // GitHubSpacePrimitives が同梱として読むのは Library/Std/ の中だけ。base_fs にはほかに
  // Library/Std.md と Repositories/Std.md があり、一覧に入れると vault の中を探して見つからず、同期が止まる
  if (!name.startsWith("Library/Std/")) continue;
  const data = await readFile(path);
  const hash = createHash("sha1").update(data).digest();
  // 同期は lastModified が等しいかだけを見る。中身が同じなら同じ値になるようにする
  const lastModified = Date.UTC(2026, 0, 1) + (hash.readUInt32BE(0) % 31_536_000_000);
  manifest.push({
    name,
    created: lastModified,
    lastModified,
    contentType: contentTypes[ext],
    size: (await stat(path)).size,
    perm: "ro",
  });
}
await writeFile(join(base, "manifest.json"), JSON.stringify(manifest));
console.log(`dist/ ready: ${manifest.length} Library/Std files`);

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}
