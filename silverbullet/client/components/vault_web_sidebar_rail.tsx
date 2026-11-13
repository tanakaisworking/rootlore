// vault-web: PC で左のサイドバーを閉じたとき、完全には消さず細い帯（レール）を残す。
// 帯の中は「サイドバーを開く」ボタンと、上部のバーから移したボタン（vault_web_sidebar_actions.tsx）。
// スマートフォンでは CSS で隠す（上部のバーの「☰」で開く）。
import { Sidebar } from "preact-feather";
import type { Client } from "../client.ts";
import { open } from "../navigator/navigator.ts";
import { SidebarActionButtons } from "./vault_web_sidebar_actions.tsx";
import { SidebarFooterButtons } from "./vault_web_dialogs.tsx";
import { t } from "../vault_web_i18n.ts";

// × で閉じると dockTarget は消える。そのとき開き直すビューを覚えておく
let lastLeftView: string | undefined;

export function rememberLeftView(view?: string): void {
  if (view) lastLeftView = view;
}

/** 左のサイドバーを開くときに出すビュー */
export function leftViewToOpen(dockTarget?: string): string {
  return dockTarget ?? lastLeftView ?? "std.spaceTree";
}

export function SidebarRail({
  dockTarget,
  client,
}: {
  dockTarget?: string;
  client: Client;
}) {
  return (
    <div className="vw-sidebar-rail">
      <button
        type="button"
        className="vw-sidebar-rail-open"
        title={t("サイドバーを開く", "Open sidebar")}
        aria-label={t("サイドバーを開く", "Open sidebar")}
        onClick={() => void open(leftViewToOpen(dockTarget))}
      >
        <Sidebar size={18} />
      </button>
      <SidebarActionButtons client={client} />
      <div className="vw-sidebar-rail-footer">
        <SidebarFooterButtons client={client} />
      </div>
    </div>
  );
}

/** 上部のバーで、帯と同じ幅をあけてタイトルの位置をそろえる */
export function SidebarRailSpacer() {
  return <div className="vw-sidebar-rail-spacer" />;
}
