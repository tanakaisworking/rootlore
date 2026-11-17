// vault-web: アプリの変更点（アップデート履歴）。画面に出す文はここに1つだけ持つ（日本語と英語の組）。
// 新しい版を出すときは、先頭に1件足す（desktop/README.md の手順）。デスクトップ版は、ここの先頭の版を
// 初めて開いたときに「アップデート履歴」を自動で開く（vault_web_desktop_menu.ts）。

export type Release = { version: string; date: string; ja: string[]; en: string[] };

export const releases: Release[] = [
  {
    version: "0.0.15",
    date: "2026-11-18",
    ja: [
      "開いてから最初のページが出るまでの数秒間、空白の画面のままだったのを、読み込み中の印を出すようにしました。",
      ".base ファイルも、上のバーの「編集」で元のファイルを直して保存したり、「削除」で消したりできるようにしました。",
      "Mac アプリで、左のファイル一覧からドラッグしてファイルを別のフォルダに移せなかった問題を直しました。",
      "フォルダも、ドラッグで中身ごと別のフォルダへ移したり、名前を変えたりできるようにしました。",
      "左のファイル一覧を右クリックすると、開く・名前を変更・パスをコピー・ここに新しいノート・削除のメニューが出るようにしました。",
      "Mac アプリの「アップデートを確認」で最新だったとき、いまのバージョンも出すようにしました。",
    ],
    en: [
      "The few seconds before the first page opens now show a loading indicator instead of an empty screen.",
      ".base files can now be edited (Edit opens the source) and deleted from the top bar.",
      "Fixed dragging files to another folder in the sidebar of the Mac app.",
      "Folders can now be dragged into another folder, with everything inside, and renamed.",
      "Right-click a file or folder in the sidebar for Open, Rename, Copy path, New note here, and Delete.",
      "In the Mac app, Check for Updates now shows the current version when you're up to date.",
    ],
  },
  {
    version: "0.0.14",
    date: "2026-11-17",
    ja: [
      "GitHub でつないだあと、アプリを開き直したり更新したりすると、つながりが切れてノートが見えなくなる問題を直しました。開いたままでも、8時間ごとに切れていたのを自動でつなぎ直します。",
    ],
    en: [
      "Fixed the GitHub connection being lost, and notes disappearing from view, when the app reopened or updated. It also renews the connection on its own instead of dropping it every eight hours.",
    ],
  },
  {
    version: "0.0.13",
    date: "2026-11-17",
    ja: [
      "ノートの名前の横に「パスをコピー」を付けました。AI に「このノートのこと」と伝えるときに、vault の中の場所（フォルダは フォルダ名/）をそのまま貼れます。",
      "上のバーの「編集」の隣に「削除」を付けました。読み込んだあとに誰か（AI など）が書き換えていたら消さずに止めます。消したノートも GitHub の履歴から戻せます。",
      "左のサイドバーの検索の隣に「ここに新しいノート」を付けました。開いているノートと同じフォルダ（フォルダの一覧ならその中）に「無題のノート」を作って、すぐ開きます。",
      "ノートのタイトルを押すと、名前を変えられるようにしました。",
      "Mac アプリをトークンでつないだとき、保存・移動・削除ができなかった問題を直しました。",
    ],
    en: [
      "Added Copy path next to the note title. Paste the note's place in your vault (a folder ends with /) to tell an AI which note you mean.",
      "Added Delete next to Edit in the top bar. If someone (such as an AI) changed the note after it was loaded, it stops instead of deleting. Deleted notes can be restored from the GitHub history.",
      "Added New note here next to Search in the sidebar. It creates an untitled note in the open note's folder (or inside an open folder) and opens it.",
      "Click a note's title to rename it.",
      "Fixed saving, moving and deleting in the Mac app when it is connected with a token.",
    ],
  },
  {
    version: "0.0.12",
    date: "2026-11-17",
    ja: [
      "GitHub でつないだとき、ノートの中身が取り込めず、探しても何も見つからなかった問題を直しました。",
      "ブラウザでログインを済ませたら、すぐにアプリが前に出て「ログインしています…」と出るようにしました。開くまでの間も、読み込み中だと分かる印を出します。",
    ],
    en: [
      "Fixed notes not loading after connecting with GitHub, which left search with no results.",
      "After you sign in in the browser, the app comes to the front right away and shows that it is signing in. While it opens, a loading indicator shows it is still working.",
    ],
  },
  {
    version: "0.0.11",
    date: "2026-11-17",
    ja: [
      "GitHub でログインしてアプリに戻ったとき、アプリが落ちてつながらなかった問題を直しました。",
      "アプリの中で思わぬ失敗が起きても、アプリごと落ちずに、その操作だけを止めて続けるようにしました。",
      "アプリの中で受け止めた失敗も、設定の「エラーの報告」がオンのときは、直すために送るようにしました（ノートの中身やファイル名は送りません）。",
    ],
    en: [
      "Fixed a crash right after signing in with GitHub, which left the app unconnected.",
      "If something unexpected fails inside the app, only that action stops; the app keeps running.",
      "Failures the app catches are now reported too when Error reports is on in Settings (never note contents or file names).",
    ],
  },
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
