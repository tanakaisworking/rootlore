// vault-web: アプリの変更点（アップデート履歴）。画面に出す文はここに1つだけ持つ（日本語と英語の組）。
// 新しい版を出すときは、先頭に1件足す（desktop/README.md の手順）。デスクトップ版は、ここの先頭の版を
// 初めて開いたときに「アップデート履歴」を自動で開く（vault_web_desktop_menu.ts）。

export type Release = { version: string; date: string; ja: string[]; en: string[] };

export const releases: Release[] = [
  {
    version: "0.0.10",
    date: "2026-11-17",
    ja: [
      "開いている間も2時間おきに新しい版を確かめ、見つかったら裏で受け取って、次に開いたときに新しくなるようにしました。",
      "新しい版を初めて開いたとき、この「アップデート履歴」で変更点を知らせるようにしました。Rootlore メニューからも開けます。",
    ],
    en: [
      "While Rootlore is open, it checks for a new version every two hours, downloads it in the background, and uses it the next time you open the app.",
      "The first time you open a new version, this Update History shows what changed. You can also open it from the Rootlore menu.",
    ],
  },
  {
    version: "0.0.9",
    date: "2026-11-17",
    ja: [
      "「アップデートを確認…」を Rootlore メニューの「Rootlore について」の下に移しました。",
      "GitHub の Issue など新しいウィンドウで開くリンクを、いつものブラウザで開くようにしました。",
      "更新の配布場所を tanakaisworking/rootlore のリリースに移しました。",
    ],
    en: [
      "Check for Updates… moved to the Rootlore menu, under About Rootlore.",
      "Links that open a new window, such as GitHub issues, now open in your default browser.",
      "Updates now come from the releases of tanakaisworking/rootlore.",
    ],
  },
  {
    version: "0.0.8",
    date: "2026-11-17",
    ja: [
      "rootlore コマンドをアプリに入れました。アプリを開くと ~/.local/bin/rootlore から使えるようになり（そこにほかの rootlore がないとき）、アプリの更新で一緒に新しくなります。",
      "ノートを開いたときの読むだけの表示で、先頭の見出しの ## とフロントマターの --- を出さないようにしました。",
    ],
    en: [
      "The app now includes the rootlore command. Opening the app makes it available as ~/.local/bin/rootlore (when nothing else is there), and app updates keep it up to date.",
      "When you open a note to read, the first heading's ## and the frontmatter's --- lines are hidden.",
    ],
  },
];

export const RELEASE_NOTES_URL = "https://github.com/tanakaisworking/rootlore/releases";
const SEEN_KEY = "rootlore-seen-release";

/** "0.0.10" と "0.0.9" を数として比べる。読めない版は 0 として扱う */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/**
 * 知らせる版（まだ見ていない新しい版）。なければ undefined。
 * 初めて開いた端末は、知らせずに今の版を覚えるだけにする（入れた直後に履歴を出さない）
 */
export function releaseToAnnounce(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  latest = releases[0]?.version,
): string | undefined {
  if (!storage || !latest) return undefined;
  let seen: string | null;
  try {
    seen = storage.getItem(SEEN_KEY);
  } catch {
    return undefined;
  }
  if (seen && compareVersions(latest, seen) <= 0) return undefined;
  try {
    storage.setItem(SEEN_KEY, latest);
  } catch {
    return undefined;
  }
  return seen ? latest : undefined;
}
