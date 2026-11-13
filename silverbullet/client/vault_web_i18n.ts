// vault-web: 画面の言語（日本語と英語）。設定のページで「システム言語・English・日本語」から選ぶ。
// 選んだものは localStorage の vw-language に残す（この端末だけ。vault には書かない）。
// 言語は読み込んだときに1回だけ決める。切り替えたら読み込み直す（文言の多くは起動時に組み立てるため）。
// 画面の外にも伝える:
// - ログイン画面（Worker が返す）: Cookie の vw-lang
// - プラグ（plugs/sync/sync.ts）: clientStore の vwLanguage
// - 同梱の Lua（Widgets.md）: js.window.vaultWebLanguage

export type LanguageSetting = "auto" | "ja" | "en";
export type Language = "ja" | "en";

const settingKey = "vw-language";

export function readLanguageSetting(
  storage: Pick<Storage, "getItem"> | undefined,
): LanguageSetting {
  const value = storage?.getItem(settingKey);
  return value === "ja" || value === "en" ? value : "auto";
}

/** 「システム言語」は、ブラウザの言語が日本語なら日本語、ほかは英語 */
export function resolveLanguage(
  setting: LanguageSetting,
  browserLanguage: string | undefined,
): Language {
  if (setting !== "auto") return setting;
  return browserLanguage?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // 保存を止めているブラウザ
  }
}

export const languageSetting: LanguageSetting = readLanguageSetting(storage());
export const language: Language = resolveLanguage(
  languageSetting,
  globalThis.navigator?.language,
);

/** 日本語と英語の文言を並べて書き、今の言語のほうを返す */
export function t(ja: string, en: string): string {
  return language === "en" ? en : ja;
}

if (globalThis.document) {
  globalThis.document.documentElement.lang = language;
  (globalThis as any).vaultWebLanguage = language;
}

/** 設定を残して読み込み直す。ログイン画面にも伝える（Cookie） */
export function saveLanguageSetting(setting: LanguageSetting): void {
  try {
    if (setting === "auto") storage()?.removeItem(settingKey);
    else storage()?.setItem(settingKey, setting);
  } catch {
    // 保存できないブラウザでは、システム言語のまま
  }
  document.cookie =
    setting === "auto"
      ? "vw-lang=; path=/; max-age=0; samesite=lax; secure"
      : `vw-lang=${setting}; path=/; max-age=31536000; samesite=lax; secure`;
}

/** 別のタブで開くリポジトリが切り替わり、この画面からは書けないとき（Worker が 412 を返す。worker/index.ts） */
export function otherRepoMessage(): string {
  return t(
    "別のタブで、開くリポジトリが切り替わりました。ページを再読み込みしてください。",
    "Another tab opened a different repository. Reload this page.",
  );
}

/** データを消すときに設定も消す */
export function clearLanguageSetting(): void {
  saveLanguageSetting("auto");
}
