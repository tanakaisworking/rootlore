import { h } from "preact";
import { render } from "preact-render-to-string";
import { expect, test, vi } from "vitest";
import type { Client } from "../client.ts";
import type { CommandHook } from "../plugos/hooks/command.ts";
import type { Command } from "../types/command.ts";
import {
  SidebarFooterButtons,
  applyFontSize,
  fetchLogin,
  readColorScheme,
  readFontSize,
  registerVaultWebDialogCommands,
  vaultWebPageFor,
  vaultWebPageText,
  vaultWebTopBarName,
} from "./vault_web_dialogs.tsx";
import { FEEDBACK_ISSUE_URL, FEEDBACK_WEB_URL, FeedbackView, sendFeedback } from "./vault_web_feedback_view.tsx";

test("文字の大きさは、残していなければ標準。知らない値も標準", () => {
  const store = (value: string | null) => ({ getItem: () => value });
  expect(readFontSize(undefined)).toBe("normal");
  expect(readFontSize(store(null))).toBe("normal");
  expect(readFontSize(store("large"))).toBe("large");
  expect(readFontSize(store("huge"))).toBe("normal");
});

test("配色は、残していなければ端末に合わせる", () => {
  const store = (value: string | null) => ({ getItem: () => value });
  expect(readColorScheme(undefined)).toBe("auto");
  expect(readColorScheme(store("dark"))).toBe("dark");
  expect(readColorScheme(store("blue"))).toBe("auto");
});

test("文字の大きさは html の属性で切り替え、標準なら属性を消す", () => {
  const root = { dataset: {} as Record<string, string> } as HTMLElement;
  applyFontSize("small", root);
  expect(root.dataset.vwFontSize).toBe("small");
  applyFontSize("normal", root);
  expect(root.dataset.vwFontSize).toBeUndefined();
});

test("ログイン名は /.auth/me から読む。読めなければ error", async () => {
  const ok = vi.fn(async () => Response.json({ login: "octocat" }));
  expect(await fetchLogin(ok as typeof fetch)).toEqual({ status: "ok", login: "octocat" });
  expect(ok).toHaveBeenCalledWith("/.auth/me", { cache: "no-store" });

  const loggedOut = async () => Response.json({ error: "login" }, { status: 401 });
  expect(await fetchLogin(loggedOut as typeof fetch)).toEqual({ status: "error" });

  const offline = async () => {
    throw new TypeError("Failed to fetch");
  };
  expect(await fetchLogin(offline as typeof fetch)).toEqual({ status: "error" });
});

test("コマンドからも開ける。ポップアップではなく、ページとして開く", async () => {
  const commands: Command[] = [];
  const hook = {
    registerCommand: (command: Command) => commands.push(command),
  } as unknown as CommandHook;
  const navigate = vi.fn(async () => {});
  registerVaultWebDialogCommands({ navigate } as unknown as Client, hook);
  expect(commands.map((c) => c.name)).toEqual(["Vault: Settings", "Vault: Account", "Vault: Share", "Vault: Skills", "Vault: Feedback"]);
  for (const command of commands) await command.run!();
  const paths = navigate.mock.calls.map((call: any[]) => call[0].path);
  expect(paths.map(vaultWebPageFor)).toEqual(["settings", "account", "share", "skills", "feedback"]);
});

test("設定とアカウントのページは同梱のページの下に置き、タイトル欄には名前だけが出る", () => {
  expect(vaultWebPageFor("Library/Std/Rootlore/設定.md")).toBe("settings");
  expect(vaultWebPageFor("Library/Std/Rootlore/アカウント.md")).toBe("account");
  expect(vaultWebPageFor("Library/Std/Rootlore/紹介.md")).toBe("share");
  // vault に同じ名前のノートがあっても、そちらはふつうのノート
  expect(vaultWebPageFor("設定.md")).toBeUndefined();
  expect(vaultWebPageFor(undefined)).toBeUndefined();
  expect(vaultWebPageText("settings")).toBe("# 設定\n");
  expect(vaultWebPageText("share")).toBe("# 紹介\n");
  expect(vaultWebPageFor("Library/Std/Rootlore/要望.md")).toBe("feedback");
  expect(vaultWebPageText("feedback")).toBe("# 要望\n");
});

test("上部のバーのファイル名は、ファイルでないページでは空にする", () => {
  expect(vaultWebTopBarName("Library/Std/Rootlore/設定.md", "ホーム.md", undefined)).toBe("");
  expect(vaultWebTopBarName("Library/Std/Rootlore/アカウント.md", "ホーム.md", undefined)).toBe("");
  expect(vaultWebTopBarName("Library/Std/Rootlore/紹介.md", "ホーム.md", undefined)).toBe("");
  // GitHub から作ったホームは空、vault の「ホーム」のノートなら名前を出す
  expect(vaultWebTopBarName("ホーム.md", "ホーム.md", "ホーム")).toBe("");
  expect(vaultWebTopBarName("ホーム.md", "ホーム.md", undefined)).toBe("ホーム");
  // ふつうのノートは呼ぶ側がノート名を出す
  expect(vaultWebTopBarName("Projects/plan.md", "ホーム.md", "ホーム")).toBeUndefined();
});


test("要望アイコンはページとして開き、GitHub を直接開かない", () => {
  const html = render(h(SidebarFooterButtons, { client: { ui: { viewState: {} } } as Client }));
  expect(html).not.toContain("github.com");
  expect(html).not.toContain('target="_blank"');
  // 設定・スキル・アカウント・紹介・要望の順に、すべてボタン
  expect(html.match(/<button/g)).toHaveLength(5);
  expect(html).toContain('aria-label="要望"');
  expect(html.lastIndexOf("<button")).toBeGreaterThan(html.indexOf('aria-label="紹介"'));
});

test("要望のページは、フォームと GitHub の Issue の2つを並べる", () => {
  const html = render(h(FeedbackView, { desktop: false }));
  expect(html).toContain(FEEDBACK_ISSUE_URL);
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  // フォームは送信ボタンが1つ。何も書いていないうちは押せない
  expect(html).toContain("<form");
  expect(html).toContain("<textarea");
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  expect(html).not.toContain("準備中");
});

test("デスクトップ版では、フォームの代わりにブラウザ版へ案内する", () => {
  const html = render(h(FeedbackView, { desktop: true }));
  expect(html).not.toContain("<form");
  expect(html).toContain(FEEDBACK_WEB_URL);
  expect(html).toContain(FEEDBACK_ISSUE_URL);
});

test("要望のフォームは /api/feedback に JSON で送り、結果を画面の状態で返す", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    expect(await sendFeedback("https://app.example/v/", "検索を速く")).toBe("sent");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.example/v/api/feedback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ message: "検索を速く" });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await sendFeedback("https://app.example/v", "x")).toBe("login");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await sendFeedback("https://app.example/v", "x")).toBe("error");
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await sendFeedback("https://app.example/v", "x")).toBe("error");
  } finally {
    vi.unstubAllGlobals();
  }
});
