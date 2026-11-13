// vault-web: 紹介のページ。SNSごとの投稿リンクと、投稿文の下書きを作る。
// リンクは各サービスが用意している共有用の入口。X と Threads は投稿文を載せられるが、
// LinkedIn と Facebook は URL だけ、Instagram と TikTok は Web から投稿文を渡せない。
// 渡せないものは、投稿文を写してからサイトを開く（画面側でコピーする）。

export const appUrl = "https://rootlore.app";

export type SharePlatform =
  | "x"
  | "threads"
  | "linkedin"
  | "facebook"
  | "instagram"
  | "tiktok";

export type ShareTarget = {
  platform: SharePlatform;
  label: string;
  /** リンクに投稿文を載せられるか。載せられないものは、写してから開く */
  carriesText: boolean;
  url: string;
};

/** 投稿文の本文（URLは入れない。URLはサービスごとに別の欄で渡す） */
export function draftBody(language: "ja" | "en"): string {
  return language === "en"
    ? "I read and edit my GitHub Markdown notes in the browser with Rootlore. No Obsidian, no sync setup."
    : "GitHubのファイルを直接編集するMarkdownノートアプリ「Rootlore」を使っています";
}

/** 写すときの投稿文（本文とURL） */
export function draftPost(language: "ja" | "en", url: string = appUrl): string {
  return `${draftBody(language)}\n\n${url}`;
}

export function shareTargets(
  language: "ja" | "en",
  body: string = draftBody(language),
  url: string = appUrl,
): ShareTarget[] {
  const enc = encodeURIComponent;
  return [
    {
      platform: "x",
      label: "X",
      carriesText: true,
      url: `https://x.com/intent/post?text=${enc(body)}&url=${enc(url)}`,
    },
    {
      platform: "threads",
      label: "Threads",
      carriesText: true,
      url: `https://www.threads.net/intent/post?text=${enc(draftPost(language, url))}`,
    },
    {
      platform: "linkedin",
      label: "LinkedIn",
      carriesText: false,
      url: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`,
    },
    {
      platform: "facebook",
      label: "Facebook",
      carriesText: false,
      url: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    },
    {
      platform: "instagram",
      label: "Instagram",
      carriesText: false,
      url: "https://www.instagram.com/",
    },
    {
      platform: "tiktok",
      label: "TikTok",
      carriesText: false,
      url: "https://www.tiktok.com/upload",
    },
  ];
}
