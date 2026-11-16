// vault-web: アップデート履歴のページ。版ごとの変更点を出す（中身は vault_web_releases.ts）。
// デスクトップ版は新しい版を初めて開いたときに自動で開く。Rootlore メニュー、設定のページ、コマンドからも開ける
import { ExternalLink } from "preact-feather";
import { language, t } from "../vault_web_i18n.ts";
import { RELEASE_NOTES_URL, releases } from "../vault_web_releases.ts";
import { PageFrame } from "./vault_web_page_frame.tsx";

export function ReleaseNotesView() {
  return (
    <PageFrame title={t("アップデート履歴", "Update History")} className="vw-release-notes">
      {releases.map((release) => (
        <section className="vw-dialog-section" key={release.version}>
          <h3>
            {release.version} <span className="vw-dialog-meta">{release.date}</span>
          </h3>
          <ul>
            {(language === "ja" ? release.ja : release.en).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ))}
      <p className="vw-dialog-meta">
        <a href={RELEASE_NOTES_URL} target="_blank" rel="noopener noreferrer">
          {t("GitHub ですべてのリリースを見る", "See all releases on GitHub")} <ExternalLink size={12} aria-hidden="true" />
        </a>
      </p>
    </PageFrame>
  );
}
