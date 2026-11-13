// GitHub App の設定（client_id と client_secret）。
// App は manifest で作り、その場で受け取った値を KV に暗号化して置く。手で値を写す手間と、写し間違いをなくすため。

import { seal, unseal } from "./session";

export type AppConfig = {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
};

const KEY = "github-app";
let cached: AppConfig | undefined;

export async function loadAppConfig(kv: KVNamespace, secret: string): Promise<AppConfig | null> {
  if (cached) return cached;
  const sealed = await kv.get(KEY);
  if (!sealed) return null;
  const config = await unseal<AppConfig>(sealed, secret);
  if (config) cached = config;
  return config;
}

export async function saveAppConfig(kv: KVNamespace, secret: string, config: AppConfig) {
  await kv.put(KEY, await seal(config, secret));
  cached = config;
}

/** manifest から作った App の値を受け取る。code は1時間だけ使える */
export async function convertManifestCode(code: string): Promise<AppConfig> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "rootlore",
    },
  });
  if (!res.ok) throw new Error(`GitHub Appの作成を確認できませんでした（${res.status}）`);
  const body = (await res.json()) as {
    id: number;
    slug: string;
    client_id: string;
    client_secret: string;
    html_url: string;
  };
  // 秘密鍵（pem）と webhook の secret は使わないので持たない
  return {
    id: body.id,
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    htmlUrl: body.html_url,
  };
}

/** host は App の名前に入れる（GitHub App の名前は GitHub 全体で重ならないようにする） */
export function appManifest(origin: string, host: string) {
  return {
    name: `rootlore-${host.replace(/[^A-Za-z0-9-]+/g, "-")}`.slice(0, 34),
    url: origin,
    hook_attributes: { url: `${origin}/.auth/webhook`, active: false },
    redirect_url: `${origin}/.auth/setup/callback`,
    callback_urls: [`${origin}/.auth/callback`],
    setup_url: `${origin}/.auth/installed`,
    description: "GitHub上のノートをブラウザで閲覧・編集するためのアプリ",
    public: false,
    request_oauth_on_install: false,
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
  };
}
