import { h } from "preact";
import { render } from "preact-render-to-string";
import { expect, test } from "vitest";
import type { Client } from "../client.ts";
import { ShareView } from "./vault_web_share_view.tsx";

const client = {
  ui: { viewState: {}, flashNotification: () => 0 },
  reportError: () => {},
} as unknown as Client;

test("紹介のページは、6つのサービスへのリンクを出す", () => {
  const html = render(h(ShareView, { client }));
  for (const url of [
    "https://x.com/intent/post?",
    "https://www.threads.net/intent/post?",
    "https://www.linkedin.com/sharing/share-offsite/",
    "https://www.facebook.com/sharer/sharer.php?",
    "https://www.instagram.com/",
    "https://www.tiktok.com/upload",
  ]) {
    expect(html).toContain(`href="${url}`);
  }
  // 外部のページは新しいタブで開く
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
});

test("紹介のページは、投稿文と写すボタンを出す", () => {
  const html = render(h(ShareView, { client }));
  expect(html).toContain("Rootlore");
  expect(html).toContain("https://rootlore.app");
  expect(html).toContain("投稿文を写す");
  expect(html).toContain("<textarea");
});
