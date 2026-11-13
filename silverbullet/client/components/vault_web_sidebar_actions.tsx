// vault-web: 上部のバーにあったボタン（設定の actionButtons）を、左のサイドバーと細い帯に並べる。
// 上部のバーのボタンは CSS で隠す（_vault_web_theme.scss）。並びと絞り込みは上部のバーと同じ。
import type { Client } from "../client.ts";
import {
  type ConfiguredActionButton,
  visibleActionButtons,
} from "../action_buttons.ts";
import { resolveButtonIcon } from "../lib/feather_icons.ts";
import { keyboardHint } from "../../plug-api/lib/shortcut.ts";
import { t } from "../vault_web_i18n.ts";
import { editNoteCommand, noteHistoryCommand } from "../vault_web_edit.ts";

type SidebarAction = {
  key: string;
  icon: any;
  title: string;
  run: () => void;
};

// ボタンの説明。元の設定（Library/Std/Config.md）の説明（英語）と、vault-web で足したボタン
// （Library/Std/Rootlore/Home.md）の説明（日本語）を、今の言語にする
const descriptions: Record<string, string> = {
  "Go to the index page": t("ホーム", "Home"),
  "Open page": t("ノートを検索", "Search notes"),
  "Go back": t("戻る", "Back"),
  "Go forward": t("進む", "Forward"),
  "編集": t("編集", "Edit"),
  "最新の状態に更新": t("最新の状態に更新", "Refresh from GitHub"),
};

// 元の設定の絵を、わかりやすい絵に替える（ノートを検索は本ではなく虫眼鏡）
const iconOverrides: Record<string, string> = {
  "Navigate: Page Picker": "search",
};

const hiddenCommand = "Open Command Palette";

export function sidebarActions(client: Client): SidebarAction[] {
  const viewState = client.ui.viewState;
  const buttons = client.config.get<ConfiguredActionButton[]>(
    "actionButtons",
    [],
  );
  return visibleActionButtons(buttons, {
    isMobile: viewState.isMobile,
    isStandalone: viewState.isStandalone,
    accountManaged: !!client.bootConfig.accountManaged,
  })
    // アカウントは下のボタン。コマンドパレットは vault-web では使わない（⌘/ も外した。editor_commands.ts）。
    // 「編集」と「履歴」は上部のバーの右端（editor_ui.tsx）
    .filter(
      (button) =>
        button.icon !== "profile" &&
        button.command !== hiddenCommand &&
        button.command !== editNoteCommand &&
        button.command !== noteHistoryCommand,
    )
    .map((button, index) => {
      const description = button.description || "";
      let title = descriptions[description] ?? description;
      const cmd = button.command && viewState.commands.get(button.command);
      const hint = cmd ? keyboardHint(cmd) : undefined;
      if (hint) title = title ? `${title} (${hint})` : hint;
      return {
        key: `${button.icon}:${button.command ?? index}`,
        icon: resolveButtonIcon(
          (button.command && iconOverrides[button.command]) || button.icon,
        ),
        title,
        run: () => {
          if (button.command) void client.runCommandByName(button.command);
          else button.run?.();
        },
      };
    });
}

export function SidebarActionButtons({ client }: { client: Client }) {
  return (
    <>
      {sidebarActions(client).map((action) => (
        <button
          type="button"
          key={action.key}
          className="vw-sidebar-action"
          title={action.title}
          aria-label={action.title}
          onClick={action.run}
        >
          <action.icon size={18} />
        </button>
      ))}
    </>
  );
}
