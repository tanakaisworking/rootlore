// vault-web: まだ GitHub に繋いでいないとき、左のサイドバーの下に「リポジトリを連携してはじめる」を出す。
// 押すとアカウントのページ（繋ぐ場所）を開く。ホームとノート一覧の案内と同じ行き先にして、動線を1つにそろえる。
// 一覧の空状態は本文と一緒に流れて見えなくなるので、繋ぐまではここにも残す。
import { ChevronRight, Github } from "preact-feather";
import type { Client } from "../client.ts";
import { t } from "../vault_web_i18n.ts";
import { openVaultWebPage } from "./vault_web_dialogs.tsx";

/** 繋いでいないときだけ出す（繋いだあとと、判定が無いときは出さない） */
export function showConnectCard(bootConfig: { connected?: boolean }): boolean {
  return bootConfig.connected === false;
}

export function SidebarConnectCard({ client }: { client: Client }) {
  if (!showConnectCard(client.bootConfig)) return null;
  return (
    <button
      type="button"
      className="vw-sidebar-connect"
      onClick={() =>
        void openVaultWebPage(client, "account").catch((e) =>
          client.reportError(e, "open page"),
        )
      }
    >
      <Github size={18} aria-hidden="true" className="vw-sidebar-connect-icon" />
      <span className="vw-sidebar-connect-text">
        <span className="vw-sidebar-connect-title">
          {t("リポジトリを連携してはじめる", "Connect your repository")}
        </span>
        <span className="vw-sidebar-connect-desc">
          {t("GitHubのノートを読み込めます", "Read your notes from GitHub")}
        </span>
      </span>
      <ChevronRight
        size={14}
        aria-hidden="true"
        className="vw-sidebar-connect-arrow"
      />
    </button>
  );
}
