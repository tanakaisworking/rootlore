// エラーの報告（Sentry）。画面とデスクトップ版のエラーは、ここ（/api/errors）を通して Sentry に送る。
// - 画面の CSP（connect-src 'self'）を緩めずに済む
// - 送り先（DSN）は Worker の secret にだけ置く。オープンソースのコードにも、配る画面にも書かない
// - ノートの中身を送らないための削りを、Web とデスクトップの両方について、ここ1か所でかける
// DSN が無い Worker（自分で動かす人の環境など）は、受け取って捨てる。
//
// 送るイベントは、決めた項目だけで組み直す（buildEvent）。画面が何を付けてきても、それ以外は届かない。
// - エラー文は、ブラウザ・JavaScript が出す種類（TypeError など）だけ残す。アプリが投げる Error の文には
//   ノートのパスが入るので送らない（種類とスタックで追う）
// - URL はページの場所（ノートの名前）を消す

/** 受け取る大きさの上限（バイト）。desktop/src-tauri/src/local.rs の ERRORS_MAX_BYTES と同じ値にする */
export const ERRORS_MAX_BYTES = 200_000;

type Dsn = { key: string; host: string; projectId: string; raw: string };
type Json = Record<string, unknown>;

export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
    if (url.protocol !== "https:" || !url.username || !/^\d+$/.test(projectId)) return null;
    return { key: url.username, host: url.host, projectId, raw: dsn };
  } catch {
    return null;
  }
}

function envelopeUrl(dsn: Dsn): string {
  return `https://${dsn.host}/api/${dsn.projectId}/envelope/?sentry_key=${dsn.key}&sentry_version=7`;
}

/** 同梱の画面のファイル（.client/ と service_worker.js）以外の場所は、ノートの名前を含みうるので伏せる */
export function redactUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "[url]";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}[url]`;
  const prefix = url.pathname.startsWith("/v/") || url.pathname === "/v" ? "/v" : "";
  const rest = url.pathname.slice(prefix.length);
  const bundled = /^\/(\.client\/[\w./-]+|service_worker\.js)$/.test(rest);
  return `${url.origin}${prefix}${bundled ? rest : "/[page]"}`;
}

/** 文を残してよいエラーの種類（ブラウザと JavaScript のエンジンが出すもの） */
const ENGINE_ERRORS = new Set([
  "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError",
  "SecurityError", "AbortError", "NetworkError", "QuotaExceededError", "InvalidStateError",
  "NotAllowedError", "NotSupportedError", "DataCloneError", "UnknownError", "TimeoutError",
]);

/**
 * エンジンが出すエラー文の中の、ノートの名前やパスが入りうる部分を伏せる。
 * 引用（'flashNotification' のような識別子は残す）、URL、/ や \ を含む語、ファイル名
 */
export function redactMessage(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const urls: string[] = [];
  return text
    // URL は先に伏せて取りのけ、あとの / を含む語の置き換えに巻き込まない
    .replace(/[a-z][\w+.-]*:\/\/[^\s"'`)]+/gi, (m) => `\u0000${urls.push(redactUrl(m)) - 1}\u0000`)
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|「[^」\n]*」|“[^”\n]*”/g, (m) =>
      /^'[A-Za-z_$][\w$]*'$/.test(m) ? m : '"[redacted]"')
    .replace(/[^\s"'`()\u0000]*[\\/][^\s"'`()\u0000]*/g, "[path]")
    // 空白の入ったファイル名もあるので、文の区切り（: や引用）から拡張子までをまとめて伏せる。
    // shortcut: 引用もパスも拡張子も無い名前（例: Page Secret not found）は見分けられない
    .replace(/[^\n"'`():\u0000]*?\.(md|base|canvas|png|jpe?g|gif|webp|svg|pdf)\b/gi, " [file]")
    .replace(/^ \[file\]/, "[file]")
    .replace(/  \[file\]/g, " [file]")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? "[url]")
    .slice(0, 500);
}

function str(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function fileOf(value: unknown): string | undefined {
  const s = str(value, 500);
  if (!s) return undefined;
  if (/^[a-z][\w+.-]*:/i.test(s)) return redactUrl(s);
  if (s === "<anonymous>" || s === "native" || s === "[native code]") return s;
  // Worker のスタックはコードの相対パス（worker/index.ts など）。公開しているコードなので残す
  return /^[\w./-]{1,200}\.(js|mjs|ts)$/.test(s) ? s : "[file]";
}

function frameOf(raw: unknown): Json | null {
  const f = obj(raw);
  if (!f) return null;
  const fn = str(f.function);
  return {
    function: fn && /^[\w$.<>[\] -]+$/.test(fn) ? fn : undefined,
    abs_path: fileOf(f.abs_path),
    filename: fileOf(f.filename),
    lineno: typeof f.lineno === "number" ? f.lineno : undefined,
    colno: typeof f.colno === "number" ? f.colno : undefined,
    in_app: typeof f.in_app === "boolean" ? f.in_app : undefined,
  };
}

function exceptionOf(raw: unknown, keepMessage: boolean): Json | null {
  const e = obj(raw);
  if (!e) return null;
  const type = str(e.type, 100);
  const safeType = type && /^[\w$.]+$/.test(type) ? type : "Error";
  const mechanism = obj(e.mechanism);
  const frames = obj(e.stacktrace)?.frames;
  return {
    type: safeType,
    value: keepMessage || ENGINE_ERRORS.has(safeType) ? redactMessage(e.value) : undefined,
    mechanism: mechanism
      ? { type: str(mechanism.type, 50), handled: typeof mechanism.handled === "boolean" ? mechanism.handled : undefined }
      : undefined,
    stacktrace: Array.isArray(frames)
      ? { frames: frames.slice(-50).map(frameOf).filter((f) => f !== null) }
      : undefined,
  };
}

/** 画面から届いてよい surface。worker は Worker 自身（reportWorkerError）だけが付ける */
const CLIENT_SURFACES = new Set(["web", "desktop"]);

/**
 * Sentry のイベントを、送ってよい項目だけで組み直す。例外のイベントでなければ null。
 * userAgent は Worker が受けたリクエストのもの（画面の SDK はヘッダーを付けない設定）。
 * fromWorker は Worker 自身の例外。Worker が投げる Error の文は、伏せたうえで残す
 */
export function buildEvent(raw: unknown, userAgent?: string | null, fromWorker = false): Json | null {
  const e = obj(raw);
  if (!e) return null;
  const values = obj(e.exception)?.values;
  if (!Array.isArray(values)) return null; // captureMessage の文は送らない
  const exceptions = values.slice(0, 5).map((v) => exceptionOf(v, fromWorker)).filter((x) => x !== null);
  if (exceptions.length === 0) return null;
  const eventId = str(e.event_id, 32);
  const release = str(e.release, 100);
  const surface = str(obj(e.tags)?.surface, 20);
  const url = str(obj(e.request)?.url, 2000);
  const sdk = obj(e.sdk);
  return {
    event_id: eventId && /^[0-9a-f]{32}$/.test(eventId) ? eventId : undefined,
    timestamp: typeof e.timestamp === "number" ? e.timestamp : Date.now() / 1000,
    platform: "javascript",
    level: e.level === "fatal" || e.level === "warning" ? e.level : "error",
    environment: e.environment === "development" ? "development" : "production",
    release: release && /^rootlore@[\w.+-]+$/.test(release) ? release : undefined,
    tags: fromWorker ? { surface: "worker" } : surface && CLIENT_SURFACES.has(surface) ? { surface } : undefined,
    request: url || userAgent
      ? {
        url: url ? redactUrl(url) : undefined,
        headers: userAgent ? { "User-Agent": userAgent.slice(0, 300) } : undefined,
      }
      : undefined,
    sdk: sdk ? { name: str(sdk.name, 50), version: str(sdk.version, 30) } : undefined,
    exception: { values: exceptions },
  };
}

function envelopeOf(dsn: Dsn, event: Json): string {
  return [
    JSON.stringify({ dsn: dsn.raw, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
}

/**
 * 画面の SDK が送ってきた envelope から、最初の例外のイベント1件だけを取り出し、組み直して Sentry の形にする。
 * SDK はイベントを1件ずつ送る。2件目以降・ほかの種類（セッション、添付など）は捨てる。通すものが無ければ null
 */
export function rewriteEnvelope(body: string, dsn: Dsn, userAgent?: string | null): string | null {
  const lines = body.split("\n");
  try {
    JSON.parse(lines[0] ?? ""); // 先頭は envelope のヘッダー。送り先は、画面が書いたものでなく Worker の DSN にする
  } catch {
    return null;
  }
  for (let i = 1; i + 1 < lines.length; i += 2) {
    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(lines[i] ?? "");
      payload = JSON.parse(lines[i + 1] ?? "");
    } catch {
      return null; // 1行に収まらない中身（添付など）が混ざっている。画面からは送らせない
    }
    if (obj(header)?.type !== "event") continue;
    const event = buildEvent(payload, userAgent);
    return event ? envelopeOf(dsn, event) : null;
  }
  return null;
}

/** 本文を上限（バイト）まで読む。超えたら null（大きな本文をまるごと読み込まない） */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function send(dsn: Dsn, envelope: string): Promise<boolean> {
  try {
    const res = await fetch(envelopeUrl(dsn), {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
    });
    return res.ok;
  } catch (e) {
    console.error("could not report error", e);
    return false;
  }
}

/** POST /api/errors（画面とデスクトップ版から）。limiter は接続元ごとの回数の上限（無ければ見ない） */
export async function handleErrors(
  req: Request,
  dsnText: string | undefined,
  limiter?: RateLimit,
): Promise<Response> {
  const reply = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return reply(405);
  // よそのサイトのページから送らせない。Origin が無いのはデスクトップ版の転送（ブラウザの外から）
  const origin = req.headers.get("Origin");
  if (origin && origin !== new URL(req.url).origin) return reply(403);
  const dsn = parseDsn(dsnText);
  // 送り先の無い Worker では、読まずに捨てる（画面は返事を気にしない）
  if (!dsn) return reply(204);
  if (limiter) {
    const key = req.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await limiter.limit({ key })).success) return reply(429);
  }
  const raw = await readCapped(req, ERRORS_MAX_BYTES);
  if (raw === null) return reply(413);
  const envelope = rewriteEnvelope(raw, dsn, req.headers.get("User-Agent"));
  if (!envelope) return reply(400);
  return reply((await send(dsn, envelope)) ? 200 : 502);
}

/** workerd の stack（"    at fn (file:line:col)"）を Sentry の frames に。古い呼び出しが先 */
function framesOf(stack: string | undefined): Json[] {
  const frames: Json[] = [];
  for (const line of (stack ?? "").split("\n").slice(1, 40)) {
    const m = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (m) frames.push({ function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return frames.reverse();
}

/** Worker 自身の例外（app.onError）を送る。DSN が無ければ何もしない */
export async function reportWorkerError(err: unknown, req: Request, dsnText: string | undefined): Promise<void> {
  const dsn = parseDsn(dsnText);
  if (!dsn) return;
  const error = err instanceof Error ? err : new Error(String(err));
  const hostname = new URL(req.url).hostname;
  const event = buildEvent({
    event_id: crypto.randomUUID().replaceAll("-", ""),
    timestamp: Date.now() / 1000,
    level: "error",
    environment: hostname === "localhost" || hostname === "127.0.0.1" ? "development" : "production",
    request: { url: req.url },
    exception: { values: [{ type: error.name, value: error.message, stacktrace: { frames: framesOf(error.stack) } }] },
  }, null, true);
  if (event) await send(dsn, envelopeOf(dsn, event));
}
