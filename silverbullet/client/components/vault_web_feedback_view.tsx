// vault-web: 要望のページ。左のサイドバーの下の Send ボタンから開く（GitHub を直接開かない）。
// 送り方は2つ: 公開される GitHub の Issue と、運営だけが読むフォーム（Worker の /api/feedback に送る。worker/feedback.ts）。
import { useState } from "preact/hooks";
import { Github } from "preact-feather";
import { Button } from "@silverbulletmd/silverbullet/ui";
import { t } from "../vault_web_i18n.ts";
import { PageFrame } from "./vault_web_page_frame.tsx";

/** Rootlore の要望を受け付ける Issue 作成。URL は画面ではなく、ここに1つだけ持つ */
export const FEEDBACK_ISSUE_URL =
  "https://github.com/tanakaisworking/rootlore/issues/new";

/** フォームが届かないデスクトップ版から案内する先（ブラウザ版の要望ページ） */
export const FEEDBACK_WEB_URL =
  "https://rootlore.app/v/Library/Std/Rootlore/%E8%A6%81%E6%9C%9B";

/** worker/feedback.ts の FEEDBACK_MAX_LENGTH と同じ */
export const FEEDBACK_MAX_LENGTH = 4000;

type SendState = "idle" | "sending" | "sent" | "error" | "login";

/** フォームの本文を Worker に送る。結果は画面の状態の名前で返す */
export async function sendFeedback(
  base: string,
  message: string,
): Promise<"sent" | "error" | "login"> {
  try {
    const res = await fetch(`${base.replace(/\/*$/, "")}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.ok) return "sent";
    return res.status === 401 ? "login" : "error";
  } catch {
    return "error";
  }
}

/**
 * デスクトップ版の手元のサーバー（desktop/src-tauri/src/local.rs）は /api/gh しか中継しない。
 * トークンで繋いだときはサーバーのログインもないので、フォームはブラウザ版だけで出す
 */
export function isDesktopApp(): boolean {
  return typeof (globalThis as any).__TAURI_INTERNALS__?.invoke === "function";
}

export function FeedbackView({
  desktop = isDesktopApp(),
}: { desktop?: boolean } = {}) {
  const [message, setMessage] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const text = message.trim();
  const tooLong = text.length > FEEDBACK_MAX_LENGTH;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!text || tooLong || state === "sending") return;
    setState("sending");
    const result = await sendFeedback(document.baseURI, text);
    setState(result);
    if (result === "sent") setMessage("");
  };

  return (
    <PageFrame title={t("要望", "Feedback")} className="vw-feedback">
      <p className="vw-feedback-lead">
        {t(
          "Rootlore への要望や、直してほしいところを送れます。",
          "Send a request, or tell us what should be better in Rootlore.",
        )}
      </p>

      <section className="vw-dialog-section">
        <h3>{t("フォームで送る", "Send with the form")}</h3>
        <p className="vw-dialog-note">
          {t(
            "公開されません。Rootlore の運営だけが読みます。",
            "Not public. Only the Rootlore team reads it.",
          )}
        </p>
        {desktop ? (
          <p className="vw-feedback-status">
            {t(
              "デスクトップ版からはフォームで送れません。ブラウザ版から送ってください。",
              "The form isn't available in the desktop app. Send it from the web version.",
            )}{" "}
            <a
              href={FEEDBACK_WEB_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("ブラウザ版で開く", "Open in browser")}
            </a>
          </p>
        ) : (
          <form className="vw-feedback-form" onSubmit={submit}>
            <textarea
              className="vw-feedback-text"
              rows={6}
              value={message}
              // 送信中に書き直した本文を、送信の完了で消さないため
              disabled={state === "sending"}
              aria-label={t("要望", "Feedback")}
              placeholder={t(
                "例: 検索の結果に、ノートの更新日も出してほしい",
                "Example: Show when each note was updated in search results",
              )}
              onInput={(e) => {
                setMessage(e.currentTarget.value);
                if (state !== "sending") setState("idle");
              }}
            />
            <div className="vw-feedback-actions">
              <Button
                type="submit"
                variant="primary"
                disabled={!text || tooLong || state === "sending"}
              >
                {state === "sending"
                  ? t("送信中…", "Sending…")
                  : t("送信する", "Send")}
              </Button>
              <span className="vw-feedback-status" role="status">
                {tooLong
                  ? t(
                      `${FEEDBACK_MAX_LENGTH}文字までにしてください。`,
                      `Keep it under ${FEEDBACK_MAX_LENGTH} characters.`,
                    )
                  : state === "sent"
                    ? t(
                        "送信しました。ありがとうございます。",
                        "Sent. Thank you.",
                      )
                    : state === "login"
                      ? t(
                          "ログインが切れています。ページを開き直してから送ってください。",
                          "Your sign-in expired. Reload the page, then send again.",
                        )
                      : state === "error"
                        ? t(
                            "送信できませんでした。時間をおいてもう一度送ってください。",
                            "Couldn't send. Try again in a moment.",
                          )
                        : ""}
              </span>
            </div>
          </form>
        )}
      </section>

      <section className="vw-dialog-section">
        <h3>{t("GitHub で送る", "Send on GitHub")}</h3>
        <div className="vw-feedback-options">
          <a
            className="vw-feedback-option"
            href={FEEDBACK_ISSUE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="vw-feedback-option-icon">
              <Github size={18} aria-hidden="true" />
            </span>
            <span className="vw-feedback-option-text">
              <span className="vw-feedback-option-name">
                {t("GitHub の Issue", "GitHub issue")}
              </span>
              <span className="vw-feedback-option-note">
                {t(
                  "ほかの人の要望も読めます。Issue は公開されるので、秘密の情報は書かないでください。",
                  "You can read other requests too. Issues are public, so do not include anything private.",
                )}
              </span>
            </span>
          </a>
        </div>
      </section>
    </PageFrame>
  );
}
