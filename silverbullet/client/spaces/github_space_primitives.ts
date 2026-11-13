// vault-web: GitHub のリポジトリをノートの保存先にする SpacePrimitives。
// HttpSpacePrimitives（SilverBullet のサーバー向け）の代わりに、Service Worker の
// 同期エンジンの remote として使う。GitHub API は Worker の /api/gh 経由で呼ぶ。
//
// - ファイル一覧は git tree を1回取る（ETag を付け、変わっていなければ 304）。
// - Markdown の本文は GraphQL で最大250件ずつまとめて取る。端末にまだない本文は
//   一覧を取った直後から先回りして取り始める。
// - 画像などは REST で1件ずつ取る。
// - Library/Std（SilverBullet の標準ライブラリ）は同梱した静的ファイルを読み取り専用で重ねる。
// - GitHub はファイルごとの更新日時を持たないので、blob SHA が変わったのを
//   この端末で最初に見た時刻を lastModified にする（同期は等しいかだけを比べる）。

import { githubApiFetch } from "../vault_web_fetch.ts";
import { notFoundError, offlineError } from "@silverbulletmd/silverbullet/constants";
import type { FileMeta } from "@silverbulletmd/silverbullet/type/index";
import mime from "mime";
import { version as publicVersion } from "../../version.json";
import type { KvPrimitives } from "../data/kv_primitives.ts";
import { stdLibPrefix } from "./constants.ts";
import type { SpacePrimitives } from "./space_primitives.ts";

export type GitHubRepoConfig = {
  owner: string;
  repo: string;
  branch: string;
  /** まだ GitHub に繋いでいない（画面は開けるが、ノートは無い） */
  disconnected?: boolean;
};

type TreeEntry = { sha: string; size: number };
type StoredTree = {
  etag: string;
  entries: Record<string, TreeEntry>;
};
type GqlBlob = {
  text: string | null;
  isBinary: boolean;
  isTruncated: boolean;
  byteSize: number;
} | null;

const treeKey = ["$github", "tree"];
const seenKey = ["$github", "seen"];
const batchSize = 250;
const maxConcurrentBatches = 3;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** ノートとして扱わないパス（Obsidian の設定、git の管理ファイルなど） */
function isIgnoredPath(path: string): boolean {
  return (
    path.split("/").some((segment) => segment.startsWith(".")) ||
    path.startsWith(stdLibPrefix)
  );
}

export class GitHubSpacePrimitives implements SpacePrimitives {
  /** 計測用。Service Worker のコンソールで `proxyRouter.syncEngine.remote.stats` で見られる */
  stats = {
    treeRequests: 0,
    tree304: 0,
    graphqlRequests: 0,
    restRequests: 0,
    blobsFetched: 0,
    bytesFetched: 0,
  };

  private tree?: StoredTree;
  private seen: Record<string, [sha: string, time: number]> = {};
  private stateLoaded?: Promise<void>;
  private treeRefresh?: Promise<void>;
  private std?: Promise<Map<string, FileMeta>>;

  // 本文の取得（blob SHA 単位）
  private blobs = new Map<string, Uint8Array>();
  private waiters = new Map<string, Deferred<Uint8Array>>();
  private queued = new Set<string>();
  private demand: string[] = [];
  private prefetch: string[] = [];
  private activeBatches = 0;

  /** 画面の言語（見本を選ぶのに使う） */
  private uiLanguage: "ja" | "en" = "ja";

  setUiLanguage(language: "ja" | "en") {
    this.uiLanguage = language;
  }

  constructor(
    private apiBase: string,
    private stdBase: string,
    private repo: GitHubRepoConfig,
    private kv: KvPrimitives,
    // 端末にまだない本文を先回りして取るために、ローカルの一覧を見る
    private local?: SpacePrimitives,
  ) {}

  async fetchFileList(): Promise<FileMeta[]> {
    // まだ繋いでいなければ、同梱した標準ライブラリと、見本（デモ）だけ。
    // 見本は画面の言語に合わせて、片方の言語のものだけを出す
    if (this.repo.disconnected) {
      // 同梱の一覧には、見本のファイルが元の名前（Demo/ja/…、Demo/en/…）で入っている。
      // そのまま出すと両方の言語が出てしまうので、見本は下で言語に合わせて入れ直す
      const std = [...(await this.loadStd()).values()].filter(
        (meta) => !meta.name.startsWith(`${stdLibPrefix}Rootlore/Demo/`),
      );
      // 見本は「はじめに」と「デモ」の2つだけを、一覧の上のほうに出す
      return [...std, ...(await this.demoFiles())];
    }
    await this.loadState();
    await this.refreshTree();
    const files: FileMeta[] = [];
    for (const [path, entry] of Object.entries(this.tree!.entries)) {
      files.push(this.metaFor(path, entry));
    }
    await this.kv.batchSet([{ key: seenKey, value: this.seen }]);
    await this.schedulePrefetch(files);
    for (const meta of (await this.loadStd()).values()) {
      files.push(meta);
    }
    return files;
  }

  async getFileMeta(path: string): Promise<FileMeta> {
    // 見本（デモ）は、標準ライブラリと同じく同梱のファイル
    const demo = this.repo.disconnected ? await this.demoMeta(path) : undefined;
    if (demo) return demo;
    if (this.repo.disconnected && !path.startsWith(stdLibPrefix)) throw notFoundError;
    if (path.startsWith(stdLibPrefix)) {
      const meta = (await this.loadStd()).get(path);
      if (!meta) throw notFoundError;
      return meta;
    }
    const entry = await this.entryFor(path);
    return this.metaFor(path, entry);
  }

  async readFile(path: string): Promise<{ data: Uint8Array; meta: FileMeta }> {
    // 見本（デモ）は、標準ライブラリと同じく同梱のファイル
    const demo = this.repo.disconnected ? await this.demoMeta(path) : undefined;
    if (demo) {
      const real = this.demoRealPath(path)!;
      const res = await fetch(`${this.stdBase}/${encodePath(real)}`);
      if (!res.ok) throw new Error(`Failed to read ${path}: ${res.status}`);
      return { data: new Uint8Array(await res.arrayBuffer()), meta: demo };
    }
    // まだ繋いでいなければ、標準ライブラリのほかは無い
    if (this.repo.disconnected && !path.startsWith(stdLibPrefix)) throw notFoundError;
    if (path.startsWith(stdLibPrefix)) {
      const meta = await this.getFileMeta(path);
      const res = await fetch(`${this.stdBase}/${encodePath(path)}`);
      if (res.status === 404) throw notFoundError;
      if (!res.ok) throw new Error(`Failed to read ${path}: ${res.status}`);
      return { data: new Uint8Array(await res.arrayBuffer()), meta };
    }
    const entry = await this.entryFor(path);
    const meta = this.metaFor(path, entry);
    const data = path.endsWith(".md")
      ? await this.loadText(entry.sha)
      : await this.fetchBlobRest(entry.sha);
    return { data, meta };
  }

  writeFile(): Promise<FileMeta> {
    return Promise.reject(new Error("Rootlore: 読み取り専用のため保存できません"));
  }

  deleteFile(): Promise<void> {
    return Promise.reject(new Error("Rootlore: 読み取り専用のため保存できません"));
  }

  /**
   * ProxyRouter が定期的に呼ぶ。GitHub には問い合わせない。
   * 返す版は、画面が「Service Worker と同じ版か」を確かめるのに使う（同じなら、版が上がったときの索引の作り直しが動く）
   */
  ping(): Promise<string | undefined> {
    if (!navigator.onLine) return Promise.reject(offlineError);
    return Promise.resolve(publicVersion);
  }

  // --- 一覧 ---

  private loadState(): Promise<void> {
    this.stateLoaded ??= (async () => {
      const [tree, seen] = await this.kv.batchGet([treeKey, seenKey]);
      this.tree = tree;
      this.seen = seen ?? {};
    })();
    return this.stateLoaded;
  }

  /** 同時に呼ばれても GitHub には1回だけ問い合わせる */
  private refreshTree(): Promise<void> {
    this.treeRefresh ??= this.fetchTree().finally(() => {
      this.treeRefresh = undefined;
    });
    return this.treeRefresh;
  }

  private async fetchTree(): Promise<void> {
    const { owner, repo, branch } = this.repo;
    const headers: Record<string, string> = {};
    if (this.tree?.etag) headers["If-None-Match"] = this.tree.etag;
    this.stats.treeRequests++;
    const res = await this.api(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { headers },
    );
    if (res.status === 304 && this.tree) {
      this.stats.tree304++;
      return;
    }
    if (!res.ok) throw new Error(`GitHub tree: ${res.status}`);
    const body = (await res.json()) as {
      truncated: boolean;
      tree: { path: string; type: string; sha: string; size?: number }[];
    };
    if (body.truncated) {
      // GitHub は、大きすぎる一覧（10万件または7MB超）を途中で打ち切る。
      // その一覧を保存すると、実際にはあるノートが「消えた」と見なされ、端末から消えてしまう。
      // 中途半端な一覧では同期しない（前の一覧をそのまま使い、呼ぶ側に知らせる）
      const message = "GitHub から返ったファイル一覧が途中で切れています。同期を中止しました。";
      console.error(`[github] ${message}`);
      throw new Error(message);
    }
    const entries: Record<string, TreeEntry> = {};
    for (const item of body.tree) {
      if (item.type !== "blob" || isIgnoredPath(item.path)) continue;
      entries[item.path] = { sha: item.sha, size: item.size ?? 0 };
    }
    this.tree = { etag: res.headers.get("ETag") ?? "", entries };
    // 古い本文はもう読まれない
    this.blobs.clear();
    await this.kv.batchSet([{ key: treeKey, value: this.tree }]);
  }

  private async entryFor(path: string): Promise<TreeEntry> {
    await this.loadState();
    if (!this.tree) await this.refreshTree();
    const entry = this.tree!.entries[path];
    if (!entry) throw notFoundError;
    return entry;
  }

  private metaFor(path: string, entry: TreeEntry): FileMeta {
    const previous = this.seen[path];
    let time: number;
    if (previous && previous[0] === entry.sha) {
      time = previous[1];
    } else {
      time = Math.max(Date.now(), previous ? previous[1] + 1 : 0);
      this.seen[path] = [entry.sha, time];
    }
    return {
      name: path,
      created: time,
      lastModified: time,
      contentType: mime.getType(path) || "application/octet-stream",
      size: entry.size,
      // shortcut: 書き込みを作るまでは読み取り専用
      perm: "ro",
    };
  }

  private loadStd(): Promise<Map<string, FileMeta>> {
    this.std ??= (async () => {
      const res = await fetch(`${this.stdBase}/manifest.json`);
      if (!res.ok) throw new Error(`Failed to load std manifest: ${res.status}`);
      const list = (await res.json()) as FileMeta[];
      return new Map(list.map((meta) => [meta.name, meta]));
    })();
    this.std.catch(() => {
      this.std = undefined;
    });
    return this.std;
  }


  // --- 見本（デモ） ---
  // まだ GitHub に繋いでいない人に、使用感を見せるための同梱のノート。
  // 画面の言語に合わせて、Demo/ja か Demo/en の片方だけを出す。
  // 繋いだら（connected）は、どちらも出さない

  private demoPrefix(): string {
    const lang = this.uiLanguage === "en" ? "en" : "ja";
    return `${stdLibPrefix}Rootlore/Demo/${lang}/`;
  }

  /**
   * 見本のノートの場所（一覧に出す名前）。言語の部分も、同梱の深い階層も落とす。
   * サイドバーの一番上に「はじめに」と「デモ」が見えるようにするため
   * （Library/Std/Rootlore/Demo/ja/デモ/… ではなく、デモ/… として出す）
   */
  private demoDisplayName(path: string): string {
    const prefix = this.demoPrefix();
    if (!path.startsWith(prefix)) return path;
    return path.slice(prefix.length);
  }

  /** 一覧に出す名前から、同梱の実際の場所に戻す */
  private demoRealPath(display: string): string | undefined {
    // 見本として出す名前（言語の部分を含まない）だけを受ける
    if (display.length === 0 || display.startsWith(stdLibPrefix) || display.includes("..")) return undefined;
    return `${this.demoPrefix()}${display}`;
  }

  private async demoMeta(display: string): Promise<FileMeta | undefined> {
    const real = this.demoRealPath(display);
    if (!real) return undefined;
    const meta = (await this.loadStd()).get(real);
    return meta ? { ...meta, name: display } : undefined;
  }

  private async demoFiles(): Promise<FileMeta[]> {
    const prefix = this.demoPrefix();
    const std = await this.loadStd();
    return [...std.values()]
      .filter((meta) => meta.name.startsWith(prefix))
      .map((meta) => ({ ...meta, name: this.demoDisplayName(meta.name) }));
  }

  // --- 本文 ---

  /** 端末にない（または古い）Markdown の本文を、一覧を取った直後から先回りして取る */
  private async schedulePrefetch(files: FileMeta[]) {
    if (!this.local) return;
    const localTimes = new Map<string, number>();
    for (const meta of await this.local.fetchFileList()) {
      localTimes.set(meta.name, meta.lastModified);
    }
    const shas: string[] = [];
    for (const meta of files) {
      if (!meta.name.endsWith(".md")) continue;
      if (localTimes.get(meta.name) === meta.lastModified) continue;
      shas.push(this.tree!.entries[meta.name].sha);
    }
    this.prefetch = shas;
    console.log("[github] prefetching", shas.length, "notes");
    this.pump();
  }

  private loadText(sha: string): Promise<Uint8Array> {
    const cached = this.blobs.get(sha);
    if (cached) return Promise.resolve(cached);
    let waiter = this.waiters.get(sha);
    if (!waiter) {
      waiter = deferred();
      this.waiters.set(sha, waiter);
    }
    if (!this.queued.has(sha)) {
      this.queued.add(sha);
      this.demand.push(sha);
    }
    this.pump();
    return waiter.promise;
  }

  private pump() {
    while (this.activeBatches < maxConcurrentBatches) {
      const batch: string[] = [];
      // 開いているノートなど、待っている要求を先にする
      while (batch.length < batchSize && this.demand.length) {
        batch.push(this.demand.shift()!);
      }
      while (batch.length < batchSize && this.prefetch.length) {
        const sha = this.prefetch.shift()!;
        if (this.queued.has(sha) || this.blobs.has(sha)) continue;
        this.queued.add(sha);
        batch.push(sha);
      }
      if (!batch.length) return;
      this.activeBatches++;
      void this.runBatch(batch).finally(() => {
        this.activeBatches--;
        this.pump();
      });
    }
  }

  private async runBatch(shas: string[]) {
    const started = performance.now();
    let results: Record<string, GqlBlob> = {};
    try {
      results = await this.fetchBlobsGraphQL(shas);
    } catch (e: any) {
      for (const sha of shas) this.fail(sha, e);
      return;
    }
    const encoder = new TextEncoder();
    await Promise.all(
      shas.map(async (sha, i) => {
        const blob = results[`b${i}`];
        try {
          if (blob === null || blob === undefined) throw notFoundError;
          let data: Uint8Array | undefined;
          if (!blob.isBinary && !blob.isTruncated && blob.text !== null) {
            data = encoder.encode(blob.text);
            // UTF-8 として読めないバイト列などで長さが合わなければ、原本を取り直す
            if (data.byteLength !== blob.byteSize) data = undefined;
          }
          data ??= await this.fetchBlobRest(sha);
          this.deliver(sha, data);
        } catch (e: any) {
          this.fail(sha, e);
        }
      }),
    );
    console.log(
      `[github] batch of ${shas.length} in ${Math.round(performance.now() - started)}ms`,
    );
  }

  private deliver(sha: string, data: Uint8Array) {
    this.queued.delete(sha);
    this.stats.blobsFetched++;
    this.stats.bytesFetched += data.byteLength;
    this.blobs.set(sha, data);
    const waiter = this.waiters.get(sha);
    if (waiter) {
      this.waiters.delete(sha);
      waiter.resolve(data);
    }
  }

  private fail(sha: string, error: Error) {
    this.queued.delete(sha);
    const waiter = this.waiters.get(sha);
    if (waiter) {
      this.waiters.delete(sha);
      waiter.reject(error);
    }
  }

  private async fetchBlobsGraphQL(shas: string[]): Promise<Record<string, GqlBlob>> {
    this.stats.graphqlRequests++;
    // query は Worker が組み立てる（worker/proxy.ts の blobsGraphQL）。結果は b0, b1, ... の順
    const res = await this.api("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shas }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL: ${res.status}`);
    const body = (await res.json()) as {
      data?: { repository: Record<string, GqlBlob> | null };
      errors?: { message: string }[];
    };
    if (!body.data?.repository) {
      throw new Error(`GitHub GraphQL: ${body.errors?.[0]?.message ?? "no data"}`);
    }
    return body.data.repository;
  }

  private async fetchBlobRest(sha: string): Promise<Uint8Array> {
    const { owner, repo } = this.repo;
    this.stats.restRequests++;
    const res = await this.api(`/repos/${owner}/${repo}/git/blobs/${sha}`, {
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    if (res.status === 404) throw notFoundError;
    if (!res.ok) throw new Error(`GitHub blob ${sha}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private api(path: string, init: RequestInit = {}): Promise<Response> {
    return githubApiFetch(this.apiBase, path, init);
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
