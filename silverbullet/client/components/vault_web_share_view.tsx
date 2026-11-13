// vault-web: 紹介のページ。SNSごとの投稿リンクと、投稿文の下書きを出す。
// 投稿文を載せられるサービスはそのまま開き、載せられないサービスは写してから開く（vault_web_share.ts）。
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  Facebook,
  Instagram,
  Linkedin,
  Share2,
  Twitter,
} from "preact-feather";
import { Button } from "@silverbulletmd/silverbullet/ui";
import type { Client } from "../client.ts";
import { copyToClipboard } from "../clipboard.ts";
import { language, t } from "../vault_web_i18n.ts";
import { draftPost, type SharePlatform, shareTargets } from "../vault_web_share.ts";
import { PageFrame } from "./vault_web_page_frame.tsx";

const icons: Partial<Record<SharePlatform, ComponentChildren>> = {
  x: <Twitter size={18} aria-hidden="true" />,
  linkedin: <Linkedin size={18} aria-hidden="true" />,
  facebook: <Facebook size={18} aria-hidden="true" />,
  instagram: <Instagram size={18} aria-hidden="true" />,
};

export function ShareView({ client }: { client: Client }) {
  const [copied, setCopied] = useState(false);
  const post = draftPost(language);
  const targets = shareTargets(language);

  const copy = async () => {
    try {
      await copyToClipboard(post);
      setCopied(true);
      client.ui.flashNotification(t("投稿文を写しました", "Copied the post"), "info");
    } catch (e) {
      client.reportError(e, "copy share text");
      client.ui.flashNotification(
        t(
          "投稿文を写せませんでした。下の欄を選んで写してください。",
          "Couldn't copy the post. Select the text below and copy it.",
        ),
        "error",
      );
    }
  };

  // 投稿文を載せられないサービスは、先に写してから開く
  const open = (url: string, carriesText: boolean) => {
    if (!carriesText) void copy();
    globalThis.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <PageFrame title={t("紹介", "Share")} className="vw-share">
      <p className="vw-share-lead">
        {t(
          "Rootloreは気に入りましたか？ひとことの投稿で紹介してください。どんな広告よりも力になります。",
          "Enjoying Rootlore? A short post telling others about it helps more than any ad.",
        )}
      </p>

      <section className="vw-dialog-section">
        <h3>{t("投稿文", "Post")}</h3>
        <textarea
          className="vw-share-text"
          readOnly
          rows={4}
          value={post}
          aria-label={t("投稿文", "Post")}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="vw-share-actions">
          <Button onClick={() => void copy()}>
            {copied ? t("写しました", "Copied") : t("投稿文を写す", "Copy post")}
          </Button>
        </div>
      </section>

      <section className="vw-dialog-section">
        <h3>{t("投稿する", "Post to")}</h3>
        <div className="vw-share-links">
          {targets.map((target) => (
            <a
              key={target.platform}
              className="vw-share-link"
              href={target.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                open(target.url, target.carriesText);
              }}
            >
              <span className="vw-share-link-icon">
                {icons[target.platform] ?? <Share2 size={18} aria-hidden="true" />}
              </span>
              <span className="vw-share-link-text">
                <span className="vw-share-link-name">{target.label}</span>
                <span className="vw-share-link-note">
                  {target.carriesText
                    ? t("投稿文が入った状態で開きます", "Opens with the post filled in")
                    : t("投稿文を写してから開きます", "Copies the post, then opens")}
                </span>
              </span>
            </a>
          ))}
        </div>
      </section>

      <p className="vw-dialog-note">
        {t(
          "投稿の前に、内容が自分に合っているか確かめてください。",
          "Check that the wording sounds like you before posting.",
        )}
      </p>
    </PageFrame>
  );
}
