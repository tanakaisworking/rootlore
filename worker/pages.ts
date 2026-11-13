// ログインまわりの画面。アプリ本体（SilverBullet）が動く前に出すので、Worker が HTML を返す。

export type Lang = "ja" | "en";

/**
 * 画面の言語。アプリの設定で選んだ言語（Cookie の vw-lang。client/vault_web_i18n.ts）、
 * なければブラウザの言語（日本語なら日本語、ほかは英語）
 */
export function pageLang(cookie: string | undefined, acceptLanguage: string | undefined): Lang {
  const chosen = /(?:^|;\s*)vw-lang=(ja|en)(?:;|$)/.exec(cookie ?? "")?.[1];
  if (chosen === "ja" || chosen === "en") return chosen;
  const first = (acceptLanguage ?? "").split(",")[0]!.trim().toLowerCase();
  return first.startsWith("ja") ? "ja" : "en";
}

const tr = (lang: Lang, ja: string, en: string) => (lang === "en" ? en : ja);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const style = `
:root { color-scheme: light dark; --bg:#f7f6f3; --card:#fff; --text:#1f1e1b; --muted:#6b675f; --line:#e4e1da; --accent:#2f5d50; --accent-text:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#191917; --card:#22221f; --text:#ecebe6; --muted:#a19d93; --line:#34332e; --accent:#7fb3a2; --accent-text:#13201c; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--text);
  font: 16px/1.8 "Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif; }
main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:32px 28px; }
.brand { font-size:13px; letter-spacing:.08em; color:var(--muted); margin:0 0 20px; }
h1 { font-size:22px; line-height:1.5; margin:0 0 12px; }
p { margin:0 0 12px; color:var(--muted); }
ul { margin:0 0 16px; padding-left:1.2em; color:var(--muted); }
code { font-size:.92em; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:1px 6px; color:var(--text); }
.button { display:block; width:100%; margin-top:20px; padding:13px 16px; border:0; border-radius:10px; background:var(--accent); color:var(--accent-text);
  font:inherit; font-weight:600; text-align:center; text-decoration:none; cursor:pointer; }
.button:focus-visible { outline:3px solid var(--line); outline-offset:2px; }
.note { font-size:13px; margin-top:16px; }
.note a { color:var(--text); }
.repos { display:grid; gap:8px; margin:20px 0 0; }
.repo { display:flex; align-items:center; gap:10px; width:100%; padding:12px 14px; border:1px solid var(--line); border-radius:10px;
  background:var(--card); color:var(--text); font:inherit; text-align:left; cursor:pointer; }
.repo:hover { border-color:var(--muted); }
.repo:focus-visible { outline:3px solid var(--line); outline-offset:2px; }
.repo-name { flex:1; min-width:0; overflow-wrap:anywhere; }
.repo-owner { color:var(--muted); }
.tag { flex:none; font-size:12px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:0 8px; }
.tag.current { color:var(--accent); border-color:var(--accent); }
main.wide { max-width:880px; }
`;

export function page(lang: Lang, title: string, body: string, { wide = false }: { wide?: boolean } = {}): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · Rootlore</title><style>${style}</style></head>
<body><main${wide ? ' class="wide"' : ""}><p class="brand">Rootlore</p>${body}</main></body></html>`;
}

export function loginPage(lang: Lang): string {
  const title = tr(lang, "ログイン", "Sign in");
  return page(
    lang,
    title,
    `<h1>${title}</h1>
<p>${tr(lang, "GitHubアカウントで本人確認を行います。リポジトリへのアクセスは、次の画面で個別に許可します。", "Sign in with your GitHub account. You'll grant access to the repository separately on the next screen.")}</p>
<a class="button" href="/.auth/login">${tr(lang, "GitHubでログイン", "Sign in with GitHub")}</a>`,
  );
}

/**
 * アプリ（デスクトップ版）に戻るページ。ふだんのブラウザでログインしたあと、使い捨ての番号を
 * `rootlore://` のリンクでアプリに渡す。ボタンを押さなくても、開いたらすぐアプリに戻る
 */
export function desktopReturnPage(lang: Lang, appUrl: string): string {
  const title = tr(lang, "アプリに戻ります", "Returning to the app");
  const href = escapeHtml(appUrl);
  return page(
    lang,
    title,
    `<meta http-equiv="refresh" content="0;url=${href}">
<h1>${title}</h1>
<p>${tr(lang, "ブラウザでのログインが済みました。アプリが開かないときは、下のボタンを押してください。このタブは閉じてかまいません。", "You're signed in. If the app doesn't open, press the button below. You can close this tab.")}</p>
<a class="button" href="${href}">${tr(lang, "アプリを開く", "Open the app")}</a>`,
  );
}

export function installPage(lang: Lang, installUrl: string): string {
  return page(
    lang,
    tr(lang, "リポジトリへのアクセス", "Repository access"),
    `<h1>${tr(lang, "ノートのリポジトリへのアクセスを許可", "Allow access to your notes repository")}</h1>
<p>${tr(lang, "GitHubの画面で「Only select repositories」を選び、ノートを置いているリポジトリだけを選んでください。", 'On GitHub, choose "Only select repositories" and select the repository that holds your notes.')}</p>
<ul><li>${tr(lang, "選んだリポジトリにだけアクセスします", "Rootlore can access only the repositories you select")}</li><li>${tr(lang, "必要な権限はファイルの読み書き（Contents）のみです", "The only permission needed is read and write access to files (Contents)")}</li></ul>
<a class="button" href="${escapeHtml(installUrl)}">${tr(lang, "GitHubで許可", "Allow on GitHub")}</a>
<p class="note">${tr(lang, "許可が完了すると、この画面に戻ります。", "You'll come back here once access is granted.")}</p>
<p class="note">${tr(lang, "ノートのリポジトリがまだないときは、", "No notes repository yet? ")}<a href="https://github.com/new" target="_blank" rel="noopener noreferrer">${tr(lang, "GitHubで新しく作成", "Create one on GitHub")}</a>${tr(lang, "してから許可してください。非公開（Private）にできます。", " first. It can be private.")}</p>`,
  );
}

/** 開くリポジトリを選ぶ画面。一覧は App を入れたリポジトリ（worker/repos.ts）。current は今開いているもの */
export function repoPage(
  lang: Lang,
  repos: { owner: string; repo: string; private: boolean }[],
  installUrl: string,
  current?: { owner: string; repo: string },
): string {
  const isCurrent = (r: { owner: string; repo: string }) =>
    !!current && `${r.owner}/${r.repo}`.toLowerCase() === `${current.owner}/${current.repo}`.toLowerCase();
  const items = repos
    .map((r) => {
      const name = `${r.owner}/${r.repo}`;
      const tag = isCurrent(r)
        ? `<span class="tag current">${tr(lang, "開いています", "Open now")}</span>`
        : r.private
          ? `<span class="tag">${tr(lang, "非公開", "Private")}</span>`
          : "";
      return `<button class="repo" type="submit" name="repo" value="${escapeHtml(name)}"><span class="repo-name"><span class="repo-owner">${escapeHtml(r.owner)}/</span>${escapeHtml(r.repo)}</span>${tag}</button>`;
    })
    .join("");
  const title = tr(lang, "開くリポジトリを選ぶ", "Choose a repository");
  return page(
    lang,
    title,
    `<h1>${title}</h1>
<p>${tr(lang, "ノートを置いているリポジトリを選んでください。あとからアカウントのページで変えられます。", "Pick the repository that holds your notes. You can change it later on the Account page.")}</p>
<form method="post" action="/.auth/repo" class="repos">${items}</form>
<p class="note">${tr(lang, "一覧にないときは、", "Not listed? ")}<a href="${escapeHtml(installUrl)}">${tr(lang, "GitHubでアクセスを許可するリポジトリを足してください", "Allow access to more repositories on GitHub")}</a>${tr(lang, "。", ".")}</p>`,
  );
}

export function setupPage(lang: Lang, manifest: unknown, state: string): string {
  return page(
    lang,
    tr(lang, "初期設定", "Setup"),
    `<h1>${tr(lang, "ログイン用のGitHub Appを作成", "Create the GitHub App for sign-in")}</h1>
<p>${tr(lang, "このサービス専用のGitHub Appを、管理者のGitHubアカウントに作成します。作成した時点では、どのリポジトリにもアクセスしません。", "This creates a GitHub App for this service under the administrator's GitHub account. It has no access to any repository when created.")}</p>
<form method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button class="button" type="submit">${tr(lang, "GitHub Appを作成", "Create GitHub App")}</button>
</form>
<p class="note">${tr(lang, "GitHubの画面で名前を確認し、「Create GitHub App」をクリックしてください。", 'On GitHub, check the name and click "Create GitHub App".')}</p>`,
  );
}

export function messagePage(lang: Lang, title: string, message: string, link?: { href: string; label: string }): string {
  return page(
    lang,
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${
      link ? `<a class="button" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>` : ""
    }`,
  );
}

type Message = { title: string; message: string; link?: { href: string; label: string } };

/** Worker が返すお知らせの画面の文言 */
export function messages(lang: Lang) {
  return {
    notReady: {
      title: tr(lang, "ただいま準備中です", "Not available yet"),
      message: tr(lang, "ログインの設定が完了していません。管理者による初期設定の完了後にご利用いただけます。", "Sign-in hasn't been set up yet. You can use this service once the administrator completes the setup."),
    },
    loginFailed: {
      title: tr(lang, "ログインできませんでした", "Couldn't sign in"),
      message: tr(lang, "ログインの有効期限が切れたか、別の画面から開かれました。もう一度ログインしてください。", "The sign-in link expired or was opened from another window. Please sign in again."),
      link: { href: "/.auth", label: tr(lang, "ログイン画面へ", "Go to sign-in") },
    },
    githubBusy: {
      title: tr(lang, "GitHubから一覧を受け取れませんでした", "Couldn't get your repositories from GitHub"),
      message: tr(lang, "GitHubが混み合っているか、つながりにくくなっています。少し待ってから、もう一度お試しください。", "GitHub is busy or hard to reach. Wait a moment, then try again."),
      // 選ぶ画面からやり直す（途中のログインがあれば引き継ぎ、なければログインに回る）
      link: { href: "/.auth/repo", label: tr(lang, "もう一度試す", "Try again") },
    },
    notAllowed: {
      title: tr(lang, "このアカウントではご利用いただけません", "This account can't use this service"),
      message: tr(lang, "現在は限定公開中のため、許可されたアカウントのみご利用いただけます。", "Access is currently limited to approved accounts."),
    },
    appCreated: {
      title: tr(lang, "GitHub Appを作成しました", "GitHub App created"),
      message: tr(lang, "続けてGitHubでログインし、ノートのリポジトリへのアクセスを許可してください。", "Next, sign in with GitHub and allow access to your notes repository."),
      link: { href: "/.auth", label: tr(lang, "ログインに進む", "Continue to sign in") },
    },
    serverError: {
      title: tr(lang, "ページを表示できませんでした", "Couldn't display this page"),
      message: tr(lang, "時間をおいて、もう一度お試しください。", "Please wait a moment and try again."),
      link: { href: "/", label: tr(lang, "ホームに戻る", "Go to home") },
    },
  } satisfies Record<string, Message>;
}

export function messageFor(lang: Lang, m: Message): string {
  return messagePage(lang, m.title, m.message, m.link);
}

/** フォームの送り先。GitHub App を作るフォームは github.com、リポジトリを選ぶフォームはこのサイト */
export type FormTarget = "github" | "self";

/** Worker が返す画面の CSP */
export function pageCsp(formTo?: FormTarget): string {
  // 選んだあとの行き先（ログインのやり直しで GitHub、CLI のログインなら手元の受け口）も form-action で確かめられるので、並べておく
  const formAction =
    formTo === "github" ? "https://github.com" : formTo === "self" ? "'self' https://github.com http://127.0.0.1:*" : "'none'";
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action ${formAction}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
