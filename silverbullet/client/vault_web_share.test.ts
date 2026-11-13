import { expect, test } from "vitest";
import { appUrl, draftBody, draftPost, shareTargets } from "./vault_web_share.ts";

const byPlatform = (language: "ja" | "en") =>
  Object.fromEntries(shareTargets(language).map((t) => [t.platform, t]));

test("紹介のリンクは6つ。並びは X、Threads、LinkedIn、Facebook、Instagram、TikTok", () => {
  expect(shareTargets("ja").map((t) => t.platform)).toEqual([
    "x",
    "threads",
    "linkedin",
    "facebook",
    "instagram",
    "tiktok",
  ]);
});

test("X は本文とURLを別の欄で渡す", () => {
  const x = byPlatform("ja").x;
  expect(x.carriesText).toBe(true);
  expect(x.url).toContain("https://x.com/intent/post?");
  expect(x.url).toContain(`text=${encodeURIComponent(draftBody("ja"))}`);
  expect(x.url).toContain(`url=${encodeURIComponent(appUrl)}`);
});

test("Threads は本文とURLをまとめて渡す", () => {
  const threads = byPlatform("ja").threads;
  expect(threads.carriesText).toBe(true);
  expect(threads.url).toContain("https://www.threads.net/intent/post?");
  expect(threads.url).toContain(encodeURIComponent(draftPost("ja")));
});

test("LinkedIn と Facebook はURLだけを渡す（投稿文は載せられない）", () => {
  const targets = byPlatform("ja");
  for (const platform of ["linkedin", "facebook"] as const) {
    expect(targets[platform].carriesText).toBe(false);
    expect(targets[platform].url).toContain(encodeURIComponent(appUrl));
    expect(targets[platform].url).not.toContain(encodeURIComponent(draftBody("ja")));
  }
  expect(targets.linkedin.url).toContain("linkedin.com/sharing/share-offsite/");
  expect(targets.facebook.url).toContain("facebook.com/sharer/sharer.php");
});

test("Instagram と TikTok は投稿画面を開くだけ（文は写してから使う）", () => {
  const targets = byPlatform("ja");
  expect(targets.instagram.carriesText).toBe(false);
  expect(targets.instagram.url).toBe("https://www.instagram.com/");
  expect(targets.tiktok.carriesText).toBe(false);
  expect(targets.tiktok.url).toBe("https://www.tiktok.com/upload");
});

test("英語の画面では英語の下書きにする", () => {
  expect(draftBody("en")).not.toBe(draftBody("ja"));
  expect(draftBody("en")).toContain("Rootlore");
  expect(draftPost("en")).toContain(appUrl);
});

test("リンクのURLは、渡したURLと本文をそのまま使う", () => {
  const targets = shareTargets("ja", "テストの文", "https://example.com/x");
  const x = targets.find((t) => t.platform === "x")!;
  expect(x.url).toContain(encodeURIComponent("テストの文"));
  expect(x.url).toContain(encodeURIComponent("https://example.com/x"));
});
