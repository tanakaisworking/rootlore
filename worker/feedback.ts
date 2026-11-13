// 要望のフォーム。画面から送られた本文を、そのまま APP_KV に1件ずつ置く。
// 公開されない（GitHub の Issue と違う）。読むのは運営だけ:
//   npx wrangler kv key list --binding APP_KV --prefix feedback: --remote
//   npx wrangler kv key get --binding APP_KV --remote "<key>"

export const FEEDBACK_MAX_LENGTH = 4000;

export type Feedback = { message: string };

export function parseFeedback(body: unknown): Feedback | null {
  if (!body || typeof body !== "object") return null;
  const { message } = body as Record<string, unknown>;
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (text.length === 0 || text.length > FEEDBACK_MAX_LENGTH) return null;
  return { message: text };
}

export async function handleFeedback(req: Request, login: string, kv: KVNamespace): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "POST") return Response.json({ error: "method" }, { status: 405, headers });
  // JSON 以外は受けない（よそのページのフォームから直接送らせない）
  if (!req.headers.get("Content-Type")?.startsWith("application/json")) {
    return Response.json({ error: "content-type" }, { status: 415, headers });
  }
  const raw = await req.text();
  if (raw.length > FEEDBACK_MAX_LENGTH * 4 + 1024) return Response.json({ error: "too-large" }, { status: 413, headers });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid" }, { status: 400, headers });
  }
  const feedback = parseFeedback(body);
  if (!feedback) return Response.json({ error: "invalid" }, { status: 400, headers });

  const createdAt = new Date().toISOString();
  // 日時で並ぶように、日時を先に置く
  const key = `feedback:${createdAt}:${crypto.randomUUID()}`;
  await kv.put(
    key,
    JSON.stringify({ ...feedback, login, createdAt, userAgent: req.headers.get("User-Agent") ?? null }),
  );
  return Response.json({ ok: true }, { status: 201, headers });
}
