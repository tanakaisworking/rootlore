import { expect, test } from "vitest";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { TopBar } from "./top_bar.tsx";

test("mobile dock controls flank the page title and actions on their matching sides", () => {
  const html = renderToString(
    h(TopBar, {
      pageName: "Project notes",
      unsavedChanges: false,
      isOnline: true,
      isLoading: false,
      notifications: [],
      onRename: async () => {},
      onDismissNotification: () => {},
      actionButtons: [],
      readOnly: false,
      leftDock: { label: "Space", expanded: false, onClick: () => {} },
      rightDock: { label: "Page history", expanded: true, onClick: () => {} },
    }),
  );

  // vault-web: 左はハンバーガーメニューで、名前は日本語（top_bar.tsx）
  const left = html.indexOf('aria-label="サイドバーを開く"');
  const title = html.indexOf('id="sb-current-page"');
  const right = html.indexOf('aria-label="Close Page history"');
  expect(left).toBeGreaterThan(-1);
  expect(title).toBeGreaterThan(left);
  expect(right).toBeGreaterThan(title);
  expect(html).toContain('aria-expanded="true"');
});
