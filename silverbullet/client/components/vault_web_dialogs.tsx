// vault-web: 設定のページとアカウントのページ（ログアウトもここ）。
// 左のサイドバーと細い帯の下のボタン、またはコマンド（Vault: Settings / Vault: Account）から開く。
// ノートと同じようにページとして開く（アドレス、戻る・進む、タイトル欄もノートと同じ）。
// ページの中身は content_manager.ts が仮に作り、本文の代わりにこの画面を出す（editor_ui.tsx）。
// 元の設定画面（Configuration: Open）は CONFIG.md に書き込むので、読み取り専用の vault-web では使えない。
// 設定はこの端末だけに残す（vault には書かない）。
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  Book,
  Clock,
  ExternalLink,
  GitBranch,
  Github,
  Globe,
  Lock,
  Package,
  RefreshCw,
  Settings,
  Send,
  Share2,
  User,
} from "preact-feather";
import { Button } from "@silverbulletmd/silverbullet/ui";
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import type { Client } from "../client.ts";
import type { CommandHook } from "../plugos/hooks/command.ts";
import { shortcutKeys, vaultShortcuts } from "../vault_web_shortcuts.ts";
import { keyboardHint } from "../../plug-api/lib/shortcut.ts";
import { version } from "../../version.json";
import { HomeView } from "./vault_web_home_view.tsx";
import { ShareView } from "./vault_web_share_view.tsx";
import { SkillsView } from "./vault_web_skills_view.tsx";
import { FeedbackView, isDesktopApp } from "./vault_web_feedback_view.tsx";
import { PageFrame as CommonPageFrame } from "./vault_web_page_frame.tsx";
import { githubApiFetch } from "../vault_web_fetch.ts";
import { clearLastSync, readLastSync, subscribeLastSync } from "../vault_web_last_sync.ts";
import { clearAllDrafts } from "../vault_web_save.ts";
import { errorReportsEnabled, saveErrorReportsSetting } from "../vault_web_error_reports.ts";
import {
  accentPresets,
  clearAccent,
  readAccent,
  saveAccent,
} from "../vault_web_accent.ts";
import {
  clearLanguageSetting,
  language,
  type LanguageSetting,
  languageSetting,
  saveLanguageSetting,
  t,
} from "../vault_web_i18n.ts";

export type VaultWebPage = "settings" | "account" | "share" | "skills" | "feedback";

// --- ページの場所 ---
// 同梱のページ（Library/Std/）の下に置き、vault のノートと名前がぶつからないようにする。
// 場所は日本語のまま変えない（英語の画面でも、ブックマークや履歴が同じページを指すように）。
// タイトル欄とブラウザのタブ名は vaultWebPageTitle() にする（top_bar.tsx、editor_ui.tsx）。

const pagePaths: Record<VaultWebPage, Path> = {
  settings: "Library/Std/Rootlore/設定.md",
  account: "Library/Std/Rootlore/アカウント.md",
  share: "Library/Std/Rootlore/紹介.md",
  skills: "Library/Std/Rootlore/スキル.md",
  feedback: "Library/Std/Rootlore/要望.md",
};

const pageTitles: Record<VaultWebPage, string> = {
  settings: t("設定", "Settings"),
  account: t("アカウント", "Account"),
  share: t("紹介", "Share"),
  skills: t("スキル", "Skills"),
  feedback: t("要望", "Feedback"),
};

/** その場所が設定やアカウントのページなら、どちらか */
export function vaultWebPageFor(path: string | undefined): VaultWebPage | undefined {
  return (Object.keys(pagePaths) as VaultWebPage[]).find(
    (page) => pagePaths[page] === path,
  );
}

export function vaultWebPageTitle(page: VaultWebPage): string {
  return pageTitles[page];
}

/**
 * タイトル欄とブラウザのタブ名に、場所の代わりに出す名前。設定とアカウントのページ、
 * 最初のページ（ホーム。場所は日本語の「ホーム」のまま）。ほかは undefined
 */
export function vaultWebTitleFor(path: string, indexPath?: string): string | undefined {
  const page = vaultWebPageFor(path);
  if (page) return vaultWebPageTitle(page);
  if (path === indexPath) return t("ホーム", "Home");
  return undefined;
}

/**
 * 上部のバーのファイル名の欄に出す名前。ファイルでないページ（設定、アカウント、vault に
 * ノートがなく GitHub から作ったホーム）は空にする。ブラウザのタブ名は vaultWebTitleFor のまま
 */
export function vaultWebTopBarName(
  path: string,
  indexPath: string | undefined,
  homeShown: string | undefined,
): string | undefined {
  if (vaultWebPageFor(path)) return "";
  if (homeShown !== undefined && homeShown === path.replace(/\.md$/, "")) return "";
  return vaultWebTitleFor(path, indexPath);
}

/** content_manager.ts で仮に作るページの中身（画面では本文の代わりに VaultWebPageView が出る） */
export function vaultWebPageText(page: VaultWebPage): string {
  return `# ${vaultWebPageTitle(page)}\n`;
}

/** 設定・アカウント・紹介のページを開く（左のサイドバーの下のボタンと、未連携の案内から使う） */
export function openVaultWebPage(
  client: Client,
  page: VaultWebPage,
): Promise<void> {
  return client.navigate({ path: pagePaths[page] });
}

export function registerVaultWebDialogCommands(
  client: Client,
  hook: CommandHook,
): void {
  hook.registerCommand({
    name: "Vault: Settings",
    ...shortcutKeys("Vault: Settings"),
    run: () => openVaultWebPage(client, "settings"),
  });
  hook.registerCommand({
    name: "Vault: Account",
    run: () => openVaultWebPage(client, "account"),
  });
  hook.registerCommand({
    name: "Vault: Share",
    run: () => openVaultWebPage(client, "share"),
  });
  hook.registerCommand({
    name: "Vault: Skills",
    run: () => openVaultWebPage(client, "skills"),
  });
  hook.registerCommand({
    name: "Vault: Feedback",
    run: () => openVaultWebPage(client, "feedback"),
  });
}

// --- 本文の文字の大きさ（localStorage に残し、html の属性で CSS を切り替える） ---

export type FontSize = "small" | "normal" | "large";
const fontSizeKey = "vw-font-size";

export function readFontSize(storage: Pick<Storage, "getItem"> | undefined): FontSize {
  const value = storage?.getItem(fontSizeKey);
  return value === "small" || value === "large" ? value : "normal";
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // 保存を止めているブラウザ
  }
}

export function applyFontSize(size: FontSize, root?: HTMLElement): void {
  const el = root ?? globalThis.document?.documentElement;
  if (!el) return;
  if (size === "normal") delete el.dataset.vwFontSize;
  else el.dataset.vwFontSize = size;
}

function saveFontSize(size: FontSize): void {
  const store = storage();
  try {
    if (size === "normal") store?.removeItem(fontSizeKey);
    else store?.setItem(fontSizeKey, size);
  } catch {
    // 保存できなくても、この画面を開いている間は効く
  }
  applyFontSize(size);
}

// 起動したらすぐ当てる（本文が一瞬標準の大きさで出ないように）
applyFontSize(readFontSize(storage()));

// --- 配色（元の「Editor: Toggle Dark Mode」と同じ場所に残す: clientStore の darkMode） ---
// 元の仕組みは拡張機能の読み込みを待ってから当てるので、開いてしばらくは端末の配色で出てしまう。
// 起動してすぐ当てられるように、localStorage にも写しておく（VaultWebDialogs が最初に当てる）。

export type ColorScheme = "auto" | "light" | "dark";
const colorSchemeKey = "vw-color-scheme";

export function readColorScheme(
  storage: Pick<Storage, "getItem"> | undefined,
): ColorScheme {
  const value = storage?.getItem(colorSchemeKey);
  return value === "light" || value === "dark" ? value : "auto";
}

function darkModeOf(scheme: ColorScheme): boolean | undefined {
  return scheme === "auto" ? undefined : scheme === "dark";
}

function currentColorScheme(client: Client): ColorScheme {
  const dark = client.ui.viewState.uiOptions.darkMode;
  return dark === undefined ? "auto" : dark ? "dark" : "light";
}

async function setColorScheme(client: Client, scheme: ColorScheme) {
  const value = darkModeOf(scheme);
  client.ui.viewDispatch({ type: "set-ui-option", key: "darkMode", value });
  try {
    if (scheme === "auto") storage()?.removeItem(colorSchemeKey);
    else storage()?.setItem(colorSchemeKey, scheme);
  } catch {
    // 下の clientStore には残る
  }
  if (value === undefined) await client.ds.delete(["client", "darkMode"]);
  else await client.ds.set(["client", "darkMode"], value);
}

/**
 * この端末のデータを消す（この画面の設定も）。
 * 元の client.wipeClient() は Service Worker の返事を待つが、返事が来ずに止まることがある。
 * 待つのは少しだけにして、そのあと自分で消す。開いている接続がある分は、読み込み直したときに消える。
 */
export async function wipeThisDevice(client: Client, waitMs = 3000): Promise<void> {
  try {
    storage()?.removeItem(fontSizeKey);
    storage()?.removeItem(colorSchemeKey);
  } catch {
    // 消せなくても続ける
  }
  clearAccent();
  clearLastSync();
  clearLanguageSetting();
  // 下書きには編集前の本文も入っている。残すと、共有の端末でノートの中身が読めてしまう
  clearAllDrafts();
  await Promise.race([
    client.wipeClient().catch((e) => console.warn("wipeClient failed", e)),
    new Promise((resolve) => setTimeout(resolve, waitMs)),
  ]);
  for (const registration of (await navigator.serviceWorker?.getRegistrations()) ?? []) {
    await registration.unregister();
  }
  for (const db of (await indexedDB.databases?.()) ?? []) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
  for (const key of (await globalThis.caches?.keys()) ?? []) {
    await caches.delete(key);
  }
}

// --- 部品 ---

function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="vw-choices" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          type="button"
          key={key}
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** テーマカラー。用意した色の丸と、好きな色を選ぶ欄 */
function AccentChoices({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const preset = accentPresets.some((p) => p.color === value);
  return (
    <div className="vw-accents" role="radiogroup" aria-label={t("テーマカラー", "Accent color")}>
      {accentPresets.map((p) => (
        <button
          type="button"
          key={p.color}
          role="radio"
          aria-checked={value === p.color}
          aria-label={t(p.ja, p.en)}
          title={t(p.ja, p.en)}
          className="vw-accent-swatch"
          style={{ "--vw-swatch": p.color }}
          onClick={() => onChange(p.color)}
        />
      ))}
      <label className="vw-accent-custom" data-checked={preset ? undefined : "true"}>
        <input
          type="color"
          value={value}
          onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)}
        />
        {t("好きな色", "Custom")}
      </label>
    </div>
  );
}

/** 押すと、その場で「本当に〜しますか」を出す。元の確認画面はボタンが英語なので使わない */
function ConfirmAction({
  label,
  question,
  confirmLabel,
  busyLabel,
  onConfirm,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<void>;
}) {
  const [step, setStep] = useState<"idle" | "asking" | "busy">("idle");
  if (step === "idle") {
    return <Button onClick={() => setStep("asking")}>{label}</Button>;
  }
  return (
    <div className="vw-confirm" role="alert">
      <p>{question}</p>
      <div className="vw-confirm-buttons">
        <Button disabled={step === "busy"} onClick={() => setStep("idle")}>
          {t("キャンセル", "Cancel")}
        </Button>
        <Button
          variant="danger"
          disabled={step === "busy"}
          onClick={() => {
            setStep("busy");
            void onConfirm().catch(() => setStep("asking"));
          }}
        >
          {step === "busy" ? busyLabel : confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/** title がなければ見出しを出さない（ボタンが1つだけの欄など） */
function Section({ title, children }: { title?: string; children: ComponentChildren }) {
  return (
    <section className="vw-dialog-section">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

function PageFrame({ page, children }: { page: VaultWebPage; children: ComponentChildren }) {
  return (
    <CommonPageFrame title={pageTitles[page]} className="vw-dialog">
      {children}
    </CommonPageFrame>
  );
}

function SettingsPage({ client }: { client: Client }) {
  const [scheme, setScheme] = useState(currentColorScheme(client));
  const [fontSize, setFontSize] = useState(readFontSize(storage()));
  const [accent, setAccent] = useState(readAccent(storage()));
  const [errorReports, setErrorReports] = useState(errorReportsEnabled() ? "on" : "off");
  return (
    <PageFrame page="settings">
      <p className="vw-dialog-note">
        {t("設定はこのブラウザにのみ保存されます。", "Settings are saved in this browser only.")}
      </p>
      <Section title={t("言語", "Language")}>
        <Choices<LanguageSetting>
          label={t("言語", "Language")}
          value={languageSetting}
          options={[
            ["auto", t("システム言語", "System language")],
            // 選ぶ人がその言語を読めるとは限らないので、言語の名前はその言語で書く
            ["en", "English"],
            ["ja", "日本語"],
          ]}
          onChange={(value) => {
            if (value === languageSetting) return;
            saveLanguageSetting(value);
            location.reload();
          }}
        />
      </Section>
      <Section title={t("テーマ", "Theme")}>
        <Choices
          label={t("テーマ", "Theme")}
          value={scheme}
          options={[
            ["auto", t("システム設定", "System")],
            ["light", t("ライト", "Light")],
            ["dark", t("ダーク", "Dark")],
          ]}
          onChange={(value) => {
            setScheme(value);
            void setColorScheme(client, value).catch((e) =>
              client.reportError(e, "save color scheme"),
            );
          }}
        />
      </Section>
      <Section title={t("テーマカラー", "Accent color")}>
        <AccentChoices
          value={accent}
          onChange={(color) => {
            setAccent(color);
            saveAccent(color);
          }}
        />
      </Section>
      <Section title={t("文字サイズ", "Text size")}>
        <Choices
          label={t("文字サイズ", "Text size")}
          value={fontSize}
          options={[
            ["small", t("小", "Small")],
            ["normal", t("標準", "Default")],
            ["large", t("大", "Large")],
          ]}
          onChange={(value) => {
            setFontSize(value);
            saveFontSize(value);
            client.editorView?.requestMeasure();
          }}
        />
      </Section>
      <Section title={t("エラーの報告", "Error reports")}>
        <Choices
          label={t("エラーの報告", "Error reports")}
          value={errorReports}
          options={[
            ["on", t("送る", "Send")],
            ["off", t("送らない", "Don't send")],
          ]}
          onChange={(value) => {
            setErrorReports(value);
            saveErrorReportsSetting(value === "on");
          }}
        />
        <p className="vw-dialog-note">
          {t(
            "アプリで起きたエラーを開発元に送り、不具合の修正に使います。ノートの本文やファイル名は送りません。",
            "Sends errors that happen in the app to the developers so they can fix problems. Note contents and file names are never sent.",
          )}
        </p>
      </Section>
      <Section title={t("キーボードショートカット", "Keyboard shortcuts")}>
        <dl className="vw-shortcuts">
          {vaultShortcuts.map((shortcut) => (
            <div key={shortcut.command}>
              <dt>{t(shortcut.ja, shortcut.en)}</dt>
              <dd><kbd>{keyboardHint(shortcut)}</kbd></dd>
            </div>
          ))}
        </dl>
        <p className="vw-dialog-note">
          {t("移動の取り消し履歴は、再読み込みするとリセットされます。", "File move history resets when you reload.")}
        </p>
      </Section>
      <Section title={t("保存データ", "Stored data")}>
        <p>
          {t(
            "ノートが正しく表示されない場合は、このブラウザに保存されたデータを削除してください。ノートをGitHubから取得し直し、表示設定も初期状態に戻ります。",
            "If your notes don't display correctly, delete the data stored in this browser. Your notes will be downloaded again from GitHub, and display settings will be reset.",
          )}
        </p>
        <ConfirmAction
          label={t("データを削除", "Delete data")}
          question={t(
            "このブラウザに保存されたデータを削除して、ページを再読み込みします。GitHub上のノートには影響しません。",
            "This deletes the data stored in this browser and reloads the page. Your notes on GitHub are not affected.",
          )}
          confirmLabel={t("削除する", "Delete")}
          busyLabel={t("削除中…", "Deleting…")}
          onConfirm={async () => {
            await wipeThisDevice(client);
            location.reload();
          }}
        />
      </Section>
      <p className="vw-dialog-meta">
        {t("バージョン", "Version")} {version}
      </p>
    </PageFrame>
  );
}

type Login = { status: "loading" } | { status: "ok"; login: string } | { status: "error" };

export async function fetchLogin(fetchFn: typeof fetch = fetch): Promise<Login> {
  try {
    const response = await fetchFn("/.auth/me", { cache: "no-store" });
    if (!response.ok) return { status: "error" };
    const body = await response.json();
    return typeof body?.login === "string" ? { status: "ok", login: body.login } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/** Worker の /.auth/profile（表示名とプロフィールの URL）。取れなければ null */
type Profile = { name: string | null; htmlUrl: string | null };

async function fetchProfile(): Promise<Profile | null> {
  try {
    const res = await fetch("/.auth/profile", { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      name: typeof body?.name === "string" && body.name ? body.name : null,
      htmlUrl: typeof body?.htmlUrl === "string" ? body.htmlUrl : null,
    };
  } catch {
    return null;
  }
}

/** GitHub の /repos/{owner}/{repo} のうち、画面に出すもの */
type RepoInfo = {
  private: boolean;
  description: string | null;
  html_url: string;
  pushed_at: string | null;
};

const updatedFormat = new Intl.DateTimeFormat(t("ja-JP", "en-US"), {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** GitHub のアイコン画像（Worker の /.auth/avatar）。読めなければ頭文字 */
function Avatar({ login }: { login?: string }) {
  const [failed, setFailed] = useState(false);
  if (!login || failed) {
    return (
      <div className="vw-avatar" aria-hidden="true">
        {login ? Array.from(login)[0]?.toUpperCase() : <User size={22} />}
      </div>
    );
  }
  return (
    <img
      className="vw-avatar"
      src="/.auth/avatar"
      alt=""
      width={56}
      height={56}
      onError={() => setFailed(true)}
    />
  );
}


/**
 * まだ GitHub に繋いでいないときの欄。アカウントのページに出す。
 * トークンを貼る道は、手元で動いているアプリだけが受け付ける（/connect/available があるかで決める）。
 * 繋いだら、その場で読み込み直してノートを読む
 */
function ConnectSection() {
  const [token, setToken] = useState("");
  const [repoName, setRepoName] = useState("");
  const [branch, setBranch] = useState("main");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [message, setMessage] = useState("");
  const [tokenAllowed, setTokenAllowed] = useState(false);

  useEffect(() => {
    // 手元のアプリだけが、トークンを貼る口を持つ
    void fetch("/connect/available", { cache: "no-store" })
      .then((res) => setTokenAllowed(res.ok))
      .catch(() => setTokenAllowed(false));
  }, []);

  const connect = async () => {
    if (!token.trim()) {
      setState("error");
      setMessage(t("トークンが空です。", "Token is empty."));
      return;
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoName.trim())) {
      setState("error");
      setMessage(t("リポジトリは owner/repo の形で入れてください（例：your-name/notes）。", "Use owner/repo, like your-name/notes."));
      return;
    }
    setState("busy");
    setMessage("");
    try {
      const res = await fetch("/connect/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), repo: repoName.trim(), branch: branch.trim() || "main" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? t("接続できませんでした。", "Couldn't connect."));
      }
      location.reload();
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title={t("GitHubに接続", "Connect to GitHub")}>
      <a className="vw-card vw-repo" href="/.auth/login">
        <span className="vw-repo-head">
          <Github size={18} aria-hidden="true" />
          <span className="vw-repo-name">
            <strong>{t("GitHubでログイン", "Sign in with GitHub")}</strong>
          </span>
          <span className="vw-card-action">
            <ExternalLink size={14} aria-hidden="true" />
          </span>
        </span>
        <span className="vw-repo-desc">
          {t("設定は要りません", "No setup needed")}
        </span>
      </a>
      {tokenAllowed && (
        <div className="vw-connect-token">
          <h4>{t("トークンを使う", "Use a token")}</h4>
          <p className="vw-account-sub">
            {t(
              "GitHubで作ったトークンで、直接つなぎます。",
              "Connect directly with a token from GitHub.",
            )}
          </p>
          <p className="vw-account-sub">
            {t(
              "必要な権限は Contents の読み書きだけです。",
              "Only Contents read and write is needed.",
            )}
          </p>
          <label>
            {t("トークン", "Token")}
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={token}
              onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)}
              placeholder="github_pat_…"
            />
          </label>
          <label>
            {t("リポジトリ（owner/repo）", "Repository (owner/repo)")}
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              value={repoName}
              onInput={(e) => setRepoName((e.currentTarget as HTMLInputElement).value)}
              placeholder="your-name/notes"
            />
          </label>
          <label>
            {t("ブランチ", "Branch")}
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              value={branch}
              onInput={(e) => setBranch((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <Button disabled={state === "busy"} onClick={() => void connect()}>
            {state === "busy" ? t("接続中…", "Connecting…") : t("接続する", "Connect")}
          </Button>
          {state === "error" && <p className="vw-connect-error">{message}</p>}
        </div>
      )}
    </Section>
  );
}

function AccountPage({ client }: { client: Client }) {
  const [login, setLogin] = useState<Login>({ status: "loading" });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null | undefined>(undefined);
  const [lastSync, setLastSync] = useState(readLastSync());
  const repo = client.bootConfig.githubRepo;
  // 開いている間に「最新の状態に更新」が終わったら、すぐ書き換える
  useEffect(() => subscribeLastSync(() => setLastSync(readLastSync())), []);
  useEffect(() => {
    void fetchLogin().then(setLogin);
    void fetchProfile().then(setProfile);
    if (repo) {
      const apiBase = `${document.baseURI.replace(/\/*$/, "")}/api/gh`;
      void githubApiFetch(
        apiBase,
        `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
      )
        .then(async (res) => (res.ok ? ((await res.json()) as RepoInfo) : null))
        .catch(() => null)
        .then(setRepoInfo);
    }
  }, []);
  const loginName = login.status === "ok" ? login.login : undefined;
  const profileUrl =
    profile?.htmlUrl ?? (loginName ? `https://github.com/${encodeURIComponent(loginName)}` : undefined);
  const repoUrl =
    repoInfo?.html_url ??
    (repo ? `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}` : undefined);
  return (
    <PageFrame page="account">
      {!repo && <ConnectSection />}
      <Section title={t("GitHubアカウント", "GitHub account")}>
        {login.status === "error" ? (
          <p className="vw-account-sub">
            {t("アカウント情報を取得できませんでした", "Couldn't load your account information")}
          </p>
        ) : (
          <a
            className="vw-card vw-profile"
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(
              `${loginName ?? ""} のプロフィールをGitHubで開く`,
              `Open ${loginName ?? ""}'s profile on GitHub`,
            )}
          >
            <Avatar login={loginName} />
            <span className="vw-profile-text">
              <span className="vw-profile-name">
                {profile?.name ?? loginName ?? t("読み込み中…", "Loading…")}
              </span>
              {loginName && <span className="vw-profile-login">@{loginName}</span>}
            </span>
            <span className="vw-card-action">
              <Github size={16} aria-hidden="true" />
              {t("プロフィール", "Profile")}
              <ExternalLink size={14} aria-hidden="true" />
            </span>
          </a>
        )}
        <p className="vw-account-sub vw-card-note">
          <Github size={13} aria-hidden="true" />
          {t("GitHubアカウントでログインしています", "Signed in with your GitHub account")}
        </p>
      </Section>
      {repo && (
        <Section title={t("接続中のリポジトリ", "Connected repository")}>
          <a
            className="vw-card vw-repo"
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(
              `${repo.owner}/${repo.repo} をGitHubで開く`,
              `Open ${repo.owner}/${repo.repo} on GitHub`,
            )}
          >
            <span className="vw-repo-head">
              <Book size={18} aria-hidden="true" />
              <span className="vw-repo-name">
                <span className="vw-repo-owner">{repo.owner}/</span>
                <strong>{repo.repo}</strong>
              </span>
              {repoInfo && (
                <span className="vw-badge">
                  {repoInfo.private ? <Lock size={12} aria-hidden="true" /> : <Globe size={12} aria-hidden="true" />}
                  {repoInfo.private ? t("非公開", "Private") : t("公開", "Public")}
                </span>
              )}
              <span className="vw-card-action">
                <Github size={16} aria-hidden="true" />
                <ExternalLink size={14} aria-hidden="true" />
              </span>
            </span>
            {repoInfo?.description && <span className="vw-repo-desc">{repoInfo.description}</span>}
            <span className="vw-repo-meta">
              <span>
                <GitBranch size={14} aria-hidden="true" />
                {repo.branch}
              </span>
              {repoInfo?.pushed_at && (
                <span>
                  <Clock size={14} aria-hidden="true" />
                  {t("最終更新 ", "Updated ")}
                  {updatedFormat.format(new Date(repoInfo.pushed_at))}
                </span>
              )}
              <span title={t("このブラウザがGitHubから最後に読み込んだ日時", "When this browser last loaded from GitHub")}>
                <RefreshCw size={14} aria-hidden="true" />
                {t("最終同期 ", "Synced ")}
                {lastSync ? updatedFormat.format(new Date(lastSync)) : t("まだ同期していません", "Not synced yet")}
              </span>
            </span>
          </a>
          {repoInfo === null && (
            <p className="vw-account-sub vw-card-note">
              {t(
                "リポジトリの詳しい情報を取得できませんでした。",
                "Couldn't load the repository details.",
              )}
            </p>
          )}
          {/* 選ぶ画面は Worker のログインの画面（worker/auth.ts の /.auth/repo）。デスクトップ版は手元のサーバーなので、ログインし直して選ぶ */}
          {!isDesktopApp() && (
            <p className="vw-account-sub vw-card-note">
              <a href="/.auth/repo?switch=1">{t("別のリポジトリを開く", "Open a different repository")}</a>
            </p>
          )}
        </Section>
      )}
      <Section>
        <ConfirmAction
          label={t("ログアウト", "Sign out")}
          question={t(
            "ログアウトすると、このブラウザに保存されたデータも削除されます。GitHub上のノートには影響しません。",
            "Signing out also deletes the data stored in this browser. Your notes on GitHub are not affected.",
          )}
          confirmLabel={t("ログアウト", "Sign out")}
          busyLabel={t("ログアウト中…", "Signing out…")}
          onConfirm={async () => {
            await wipeThisDevice(client);
            location.href = "/.logout";
          }}
        />
      </Section>
    </PageFrame>
  );
}

/**
 * editor_ui.tsx の本文の隣に置く。設定やアカウントのページを開いているときは、本文の代わりにその画面を出す
 * （本文は CSS で隠す: `#sb-main:has(> .vw-page) > #sb-editor`）。起動したときに配色も当て、
 * 言語をプラグに伝える（clientStore の vwLanguage。plugs/sync/sync.ts が読む）
 */
export function VaultWebPageView({ client, path }: { client: Client; path?: string }) {
  useEffect(() => {
    const value = darkModeOf(readColorScheme(storage()));
    if (value !== undefined) {
      client.ui.viewDispatch({ type: "set-ui-option", key: "darkMode", value });
    }
    void client.ds?.set(["client", "vwLanguage"], language).catch(() => {});
  }, []);
  const page = vaultWebPageFor(path);
  if (page === "settings") return <SettingsPage client={client} />;
  if (page === "account") return <AccountPage client={client} />;
  if (page === "share") return <ShareView client={client} />;
  if (page === "skills") {
    return (
      <SkillsView
        client={client}
        onConnect={() => void openVaultWebPage(client, "account")}
      />
    );
  }
  if (page === "feedback") return <FeedbackView />;
  // ホーム（vault に同じ名前のノートがなく、GitHub から作ったとき）
  if (
    path &&
    client.contentManager?.vaultWebHomeShown === path.replace(/\.md$/, "")
  ) {
    return <HomeView client={client} />;
  }
  return null;
}

/** 左のサイドバーと細い帯の下に置くボタン */
export function SidebarFooterButtons({ client }: { client: Client }) {
  const current = vaultWebPageFor(client.ui.viewState.current?.path);
  const button = (page: VaultWebPage, icon: ComponentChildren) => (
    <button
      type="button"
      className="vw-sidebar-action"
      title={page === "settings" ? `${pageTitles[page]} (${keyboardHint(shortcutKeys("Vault: Settings"))})` : pageTitles[page]}
      aria-label={pageTitles[page]}
      aria-current={current === page ? "page" : undefined}
      onClick={() =>
        void openVaultWebPage(client, page).catch((e) => client.reportError(e, "open page"))
      }
    >
      {icon}
    </button>
  );
  return (
    <>
      {button("settings", <Settings size={18} />)}
      {button("skills", <Package size={18} />)}
      {button("account", <User size={18} />)}
      {button("share", <Share2 size={18} />)}
      {button("feedback", <Send size={18} />)}
    </>
  );
}
