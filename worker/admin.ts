// 管理画面（/v/admin）。いまは要望のフォームで届いた本文（worker/feedback.ts）を新しい順に見るだけ。
// 見られるのは ADMIN_LOGINS のアカウントだけ。ほかの人には、ページがあること自体を見せない（404）。

import type { Env } from "./env";
import { escapeHtml, page, type Lang } from "./pages";

export type FeedbackEntry = {
  key: string;
  message: string;
  login: string;
  createdAt: string;
  userAgent: string | null;
};

export function isAdmin(env: Env, login: string): boolean {
  const admins = (env.ADMIN_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(login.toLowerCase());
}

/** 本文を読むのは新しい順にこの件数まで（KV は1リクエストで1,000操作まで。キー一覧は1回で1,000件ずつ） */
export const FEEDBACK_SHOWN = 200;

/** 要望を新しい順に、FEEDBACK_SHOWN 件まで返す。total は全件数。shortcut: 古いものを見る手段はまだない */
export async function listFeedback(kv: KVNamespace): Promise<{ entries: FeedbackEntry[]; total: number }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "feedback:", cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // キーは日時で始まるので、キーの逆順が新しい順
  keys.sort().reverse();
  const entries = await Promise.all(
    keys.slice(0, FEEDBACK_SHOWN).map(async (key) => {
      const raw = await kv.get(key);
      if (!raw) return null;
      try {
        const data = JSON.parse(raw) as Partial<FeedbackEntry>;
        if (typeof data.message !== "string") return null;
        return {
          key,
          message: data.message,
          login: typeof data.login === "string" ? data.login : "",
          createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
          userAgent: typeof data.userAgent === "string" ? data.userAgent : null,
        };
      } catch {
        return null;
      }
    }),
  );
  return { entries: entries.filter((e): e is FeedbackEntry => e !== null), total: keys.length };
}

/** 日本時間で「2026-11-10 18:30」の形にする */
function formatJst(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

const adminStyle = `<style>
.feedback { list-style:none; margin:0; padding:0; color:var(--text); }
.feedback li { border-top:1px solid var(--line); padding:16px 0; }
.feedback .meta { margin:0 0 6px; font-size:13px; }
.feedback .body { margin:0; color:var(--text); white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.8; }
.feedback .ua { margin:6px 0 0; font-size:12px; overflow-wrap:anywhere; }
</style>`;

export function adminPage(lang: Lang, entries: FeedbackEntry[], total: number): string {
  const ja = lang !== "en";
  const title = ja ? "管理: 要望" : "Admin: Feedback";
  const count = total > entries.length
    ? (ja ? `${total}件のうち、新しい${entries.length}件。` : `Newest ${entries.length} of ${total}.`)
    : (ja ? `${total}件。新しい順。` : `${total} in total, newest first.`);
  const items = entries.length === 0
    ? `<p>${ja ? "まだ届いていません。" : "Nothing yet."}</p>`
    : `<ul class="feedback">${
      entries
        .map(
          (e) =>
            `<li><p class="meta">${escapeHtml(formatJst(e.createdAt))} · ${escapeHtml(e.login)}</p>` +
            `<p class="body">${escapeHtml(e.message)}</p>` +
            (e.userAgent ? `<p class="ua">${escapeHtml(e.userAgent)}</p>` : "") +
            `</li>`,
        )
        .join("")
    }</ul>`;
  return page(lang, title, `${adminStyle}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(count)}</p>${items}`, { wide: true });
}
