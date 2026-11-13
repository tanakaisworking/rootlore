export type Env = {
  ASSETS: Fetcher;
  /** GitHub App の設定を置く */
  APP_KV: KVNamespace;
  /**
   * ログインしてよい GitHub アカウント（カンマ区切り）。空か無ければ、誰でもログインできる。
   * セルフホストで自分だけに絞るときに使う
   */
  ALLOWED_LOGINS?: string;
  /** 管理画面（/v/admin）を見てよい GitHub アカウント（カンマ区切り） */
  ADMIN_LOGINS: string;
  /** Cookie と KV の暗号化の鍵（secret） */
  SESSION_SECRET: string;
  /** 初期設定の画面を開くための合言葉（secret）。App を作ったあとは使わない */
  SETUP_TOKEN?: string;
  /** 手元の開発だけで使うトークン（`gh auth token`）。localhost 以外では使わない */
  DEV_GITHUB_TOKEN?: string;
  /** 手元の開発で開くリポジトリ（"owner/repo"）。DEV_GITHUB_TOKEN と一緒に使う */
  DEV_GITHUB_REPO?: string;
  /** DEV_GITHUB_REPO のブランチ。無ければ main */
  DEV_GITHUB_BRANCH?: string;
  /** Worker 自身の例外を送る Sentry の DSN（secret）。無ければ送らない（worker/errors.ts） */
  SENTRY_DSN?: string;
  /** 画面とデスクトップ版のエラーを送る Sentry の DSN（secret）。無ければ /api/errors は受け取って捨てる */
  SENTRY_APP_DSN?: string;
  /** /api/errors の回数の上限（wrangler.jsonc の ratelimits） */
  ERRORS_LIMIT?: RateLimit;
};
