// vault-web: ホームの画面。上から草のグラフ、グロースグラフ、最近の更新、知識マップ。
// 中身は vault_web_home.ts が GitHub から取って homeState に残す。知識マップは元の索引から作る。
// 設定のページと同じく、本文の代わりに出す（vault_web_dialogs.tsx の VaultWebPageView から）。
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Client } from "../client.ts";
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import { t } from "../vault_web_i18n.ts";
import { PageFrame } from "./vault_web_page_frame.tsx";
import {
  type CommitDetail,
  dateFormat,
  FILES_PER_COMMIT,
  getHomeState,
  type HomeState,
  subscribeHome,
} from "../vault_web_home.ts";
import { type ActivityDay, activityDays, niceMax } from "../vault_web_activity.ts";
import type { Growth } from "../vault_web_growth.ts";
import {
  buildKnowledgeMap,
  knowledgeMapNodeRadius,
  type MapNode,
  type MapPage,
  type MapRelation,
} from "../vault_web_knowledge_map.ts";

function useHomeState(): HomeState {
  const [state, setState] = useState(getHomeState());
  useEffect(() => subscribeHome(() => setState(getHomeState())), []);
  return state;
}

export function HomeView({ client }: { client: Client }) {
  const state = useHomeState();
  const [mapFull, setMapFull] = useState(false);
  const days =
    Array.isArray(state.activity) ? activityDays(state.activity, Date.now()) : undefined;
  // まだ GitHub に繋いでいないときは、4つの欄が何を出す場所かを、見本つきで見せる。
  // 繋ぐ前に「ここに何が出るのか」が分かるようにするため（操作の行き止まりにしない）
  if (client.bootConfig.connected === false) return <DisconnectedHome client={client} />;
  return (
    <PageFrame title={t("ホーム", "Home")} className="vw-home">
        <Section title={t("更新の記録", "Contributions")}>
          {days ? (
            <ContributionGraph days={days} />
          ) : (
            <ActivityStatus activity={state.activity} />
          )}
        </Section>
        <Section title={t("成長の記録", "Growth")}>
          {state.growth ? (
            <GrowthGraph growth={state.growth} />
          ) : (
            <GrowthStatus growth={state.growth} />
          )}
        </Section>
        <Section title={t("最近の更新", "Recent updates")}>
          <RecentUpdates client={client} commits={state.commits} />
        </Section>
        <Section
          title={t("知識マップ", "Knowledge map")}
          action={
            // 元のコマンド（Graph: Global Page Map）は iframe の中で eval して描くが、
            // CSP（scripts/build.mjs）で止まり、枠だけになる。ホームのマップをそのまま広げる
            <button type="button" className="vw-home-link-button" onClick={() => setMapFull(true)}>
              {t("全画面で開く", "Open full screen")}
            </button>
          }
        >
          <KnowledgeMap
            client={client}
            version={state.version}
            full={mapFull}
            onClose={() => setMapFull(false)}
          />
        </Section>
    </PageFrame>
  );
}


/**
 * まだ GitHub に繋いでいないときのホーム。
 * 4つの欄（更新の記録・成長の記録・最近の更新・知識マップ）が、それぞれ何を出す場所かを、
 * 見本と一緒に見せる。上に接続の案内を置く
 */
function DisconnectedHome({ client }: { client: Client }) {
  return (
    <PageFrame title={t("ホーム", "Home")} className="vw-home">
      <section className="vw-home-welcome">
        <h2>{t("ノートを読み込みますか", "Load your notes?")}</h2>
        <p>
          {t(
            "GitHubのリポジトリにつなぐと、ノートが読めるようになります。",
            "Connect a GitHub repository to read your notes.",
          )}
        </p>
        <a className="vw-home-connect" href="/Library/Std/Rootlore/アカウント">
          {t("GitHubに接続", "Connect to GitHub")}
        </a>
      </section>

      <Section title={t("更新の記録", "Contributions")}>
        <div className="vw-home-preview" aria-hidden="true">
          {Array.from({ length: 7 * 16 }, (_, i) => (
            <i key={i} data-level={[0, 0, 1, 0, 2, 0, 0, 3, 0, 1, 0, 0, 2, 0, 0, 1][i % 16]} />
          ))}
        </div>
      </Section>

      <Section title={t("成長の記録", "Growth")}>
        <div className="vw-home-preview vw-home-preview-growth" aria-hidden="true">
          <span style={{ height: "38%" }} />
          <span style={{ height: "52%" }} />
          <span style={{ height: "64%" }} />
          <span style={{ height: "79%" }} />
          <span style={{ height: "88%" }} />
        </div>
      </Section>

      <Section title={t("最近の更新", "Recent updates")}>
        <ol className="vw-home-commits vw-home-preview-list" aria-hidden="true">
          <li className="vw-home-commit">
            <div className="vw-home-commit-line">
              <span className="vw-home-commit-date">11/07</span>
              <span className="vw-home-commit-title">
                {t("料金方針を更新。新しいプラン案を追記", "Update pricing policy and add a draft plan")}
              </span>
            </div>
            <div className="vw-home-files">
              <span>{t("料金方針", "Pricing policy")}</span>
              <span>{t("プラン案", "Draft plan")}</span>
            </div>
          </li>
          <li className="vw-home-commit">
            <div className="vw-home-commit-line">
              <span className="vw-home-commit-date">11/06</span>
              <span className="vw-home-commit-title">{t("議事録を3件追加", "Add 3 meeting notes")}</span>
            </div>
            <div className="vw-home-files">
              <span>{t("議事録", "Meeting notes")}</span>
              <span className="vw-home-file-more">{t("ほか2件", "+2 more")}</span>
            </div>
          </li>
        </ol>
      </Section>

      <Section title={t("知識マップ", "Knowledge map")}>
        <div className="vw-home-preview vw-home-preview-map" aria-hidden="true">
          <svg viewBox="0 0 320 120" role="presentation">
            <line x1="60" y1="40" x2="150" y2="70" />
            <line x1="150" y1="70" x2="250" y2="35" />
            <line x1="150" y1="70" x2="210" y2="100" />
            <line x1="60" y1="40" x2="90" y2="95" />
            <circle cx="60" cy="40" r="7" />
            <circle cx="150" cy="70" r="9" />
            <circle cx="250" cy="35" r="6" />
            <circle cx="210" cy="100" r="6" />
            <circle cx="90" cy="95" r="5" />
          </svg>
        </div>
      </Section>
    </PageFrame>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section className="vw-home-section">
      <div className="vw-home-section-header">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Note({ children }: { children: ComponentChildren }) {
  return <p className="vw-home-note">{children}</p>;
}

// --- 最近の更新 ---

/** 1件のコミットで名前を出すファイルの数。ほかは「ほか○件」 */
const FILES_SHOWN = 3;

function RecentUpdates({
  client,
  commits,
}: {
  client: Client;
  commits: CommitDetail[] | null | undefined;
}) {
  if (commits === undefined) return <Note>{t("読み込み中…", "Loading…")}</Note>;
  if (commits === null) {
    return (
      <Note>
        {t(
          "更新履歴を取得できませんでした。サイドバーの「最新の状態に更新」から再度お試しください。",
          "Couldn't load recent updates. Try again with Refresh from GitHub in the sidebar.",
        )}
      </Note>
    );
  }
  if (commits.length === 0) {
    return <Note>{t("更新履歴はまだありません。", "No updates yet.")}</Note>;
  }
  return (
    <ol className="vw-home-commits">
      {commits.map((c) => (
        <CommitItem key={c.sha} client={client} commit={c} />
      ))}
    </ol>
  );
}

function CommitItem({ client, commit }: { client: Client; commit: CommitDetail }) {
  const title =
    commit.commit.message.split("\n")[0]!.trim() || t("（コメントなし）", "(no message)");
  const when = commit.commit.author?.date
    ? dateFormat.format(new Date(commit.commit.author.date))
    : "";
  // ノートを先に並べる
  const all = [...(commit.files ?? [])].sort(
    (a, b) => Number(b.filename.endsWith(".md")) - Number(a.filename.endsWith(".md")),
  );
  const files = all.slice(0, FILES_SHOWN);
  const rest = all.length - files.length;
  // 取った数が上限に届いていたら、実際にはもっと多い
  const restLabel = all.length > FILES_PER_COMMIT
    ? t(`ほか${rest}件以上`, `+${rest} more`)
    : t(`ほか${rest}件`, `+${rest} more`);
  return (
    <li className="vw-home-commit">
      <div className="vw-home-commit-line">
        <span className="vw-home-commit-date">{when}</span>
        <span className="vw-home-commit-title" title={title}>{title}</span>
      </div>
      {files.length > 0 && (
        <div className="vw-home-files">
          {files.map((f) => {
            const isNote = f.filename.endsWith(".md");
            const name = isNote ? f.filename.slice(0, -3) : f.filename;
            const base = name.slice(name.lastIndexOf("/") + 1);
            if (f.status === "removed") {
              return <s key={f.filename} title={f.filename}>{base}</s>;
            }
            if (!isNote) {
              return <span key={f.filename} title={f.filename}>{base}</span>;
            }
            return (
              <a
                key={f.filename}
                href={`/${encodeURI(name)}`}
                title={f.filename}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  void client.navigate({ path: f.filename as Path });
                }}
              >
                {base}
              </a>
            );
          })}
          {rest > 0 && <span className="vw-home-file-more">{restLabel}</span>}
        </div>
      )}
    </li>
  );
}

// --- 草のグラフとグロースグラフ ---

function ActivityStatus({ activity }: { activity: HomeState["activity"] }) {
  if (activity === "pending") {
    return (
      <Note>
        {t(
          "GitHubで集計中です。しばらくしてから「最新の状態に更新」を押してください。",
          "GitHub is still counting. Press Refresh from GitHub in a moment.",
        )}
      </Note>
    );
  }
  if (activity === null) {
    return (
      <Note>
        {t(
          "更新の記録を取得できませんでした。サイドバーの「最新の状態に更新」から再度お試しください。",
          "Couldn't load the update history. Try again with Refresh from GitHub in the sidebar.",
        )}
      </Note>
    );
  }
  return <Note>{t("読み込み中…", "Loading…")}</Note>;
}

const locale = t("ja-JP", "en-US");
const monthFormat = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat(locale, {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const updates = (n: number) => t(`${n}回`, `${n} ${n === 1 ? "update" : "updates"}`);

/** 月が変わる列に、月の名前を出す */
function monthLabels(days: ActivityDay[]): { column: number; label: string }[] {
  const labels: { column: number; label: string }[] = [];
  let last = "";
  for (const d of days) {
    if (d.row !== 0 && d !== days[0]) continue;
    const month = d.date.slice(0, 7);
    if (month === last) continue;
    last = month;
    labels.push({ column: d.column, label: monthFormat.format(new Date(d.date)) });
  }
  // いちばん左の月は、列が足りず次の月と重なるなら出さない
  if (labels.length > 1 && labels[1]!.column - labels[0]!.column < 3) labels.shift();
  return labels;
}

const CELL = 11;
const GAP = 3;
const LEFT = 28;
const TOP = 16;

function ContributionGraph({ days }: { days: ActivityDay[] }) {
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const columns = Math.max(...days.map((d) => d.column)) + 1;
  const width = LEFT + columns * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const weekdays = t("日月火水木金土", "SMTWTFS");
  return (
    <div>
      <p className="vw-home-summary">
        {t(`過去1年で ${updates(total)}更新`, `${updates(total)} in the last year`)}
      </p>
      <div className="vw-home-graph-scroll">
        <svg
          className="vw-contrib"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={t(`過去1年で ${updates(total)}更新`, `${updates(total)} in the last year`)}
        >
          {monthLabels(days).map((m) => (
            <text key={m.column} x={LEFT + m.column * (CELL + GAP)} y={10} className="vw-graph-label">
              {m.label}
            </text>
          ))}
          {[1, 3, 5].map((row) => (
            <text
              key={row}
              x={0}
              y={TOP + row * (CELL + GAP) + CELL - 2}
              className="vw-graph-label"
            >
              {t(weekdays[row]!, ["", "Mon", "", "Wed", "", "Fri", ""][row]!)}
            </text>
          ))}
          {days.map((d) => (
            <rect
              key={d.date}
              x={LEFT + d.column * (CELL + GAP)}
              y={TOP + d.row * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={2}
              className={`vw-contrib-cell vw-level-${d.level}`}
            >
              <title>
                {t(
                  `${dayFormat.format(new Date(d.date))}: ${updates(d.count)}`,
                  `${updates(d.count)} on ${dayFormat.format(new Date(d.date))}`,
                )}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="vw-contrib-legend" aria-hidden="true">
        {t("少ない", "Less")}
        {[0, 1, 2, 3, 4].map((level) => (
          <svg key={level} width={CELL} height={CELL}>
            <rect width={CELL} height={CELL} rx={2} className={`vw-contrib-cell vw-level-${level}`} />
          </svg>
        ))}
        {t("多い", "More")}
      </div>
    </div>
  );
}

const G_WIDTH = 720;
const G_HEIGHT = 240;
const G_LEFT = 52;
const G_RIGHT = 12;
const G_TOP = 12;
const G_BOTTOM = 26;
const DAY_MS = 86400000;

const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const localMonthFormat = new Intl.DateTimeFormat(locale, { month: "short" });
const localDayFormat = new Intl.DateTimeFormat(locale, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/** バイト数を KB / MB で */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${numberFormat.format(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${numberFormat.format(Math.round(bytes / 1024))}KB`;
  return `${bytes}B`;
}

/** フォルダの色（明るい配色でも暗い配色でも見分けられる色）。「その他」は灰色 */
const GROWTH_COLORS = ["#7f6df2", "#3b9ede", "#2fb380", "#e5a630", "#e0607e", "#8c6bb1"];
const OTHER_COLOR = "#9aa0a6";
const seriesColor = (folder: string | null, i: number) =>
  folder === null ? OTHER_COLOR : GROWTH_COLORS[i % GROWTH_COLORS.length]!;

const folderName = (folder: string | null) =>
  folder === null ? t("その他", "Other") : folder === "" ? t("フォルダなし", "No folder") : folder;

const notesCount = (n: number) =>
  t(`${numberFormat.format(n)}件`, `${numberFormat.format(n)} ${n === 1 ? "note" : "notes"}`);

/** 月が変わるところの位置（多いときは間引く） */
function monthTicks(start: number, end: number): number[] {
  const ticks: number[] = [];
  const d = new Date(start);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() + 1);
  while (d.getTime() <= end) {
    ticks.push(d.getTime());
    d.setMonth(d.getMonth() + 1);
  }
  const step = Math.ceil(ticks.length / 12);
  return ticks.filter((_, i) => i % step === 0);
}

function GrowthStatus({ growth }: { growth: HomeState["growth"] }) {
  if (growth === null) {
    return (
      <Note>
        {t(
          "成長の記録を取得できませんでした。サイドバーの「最新の状態に更新」から再度お試しください。",
          "Couldn't load the growth history. Try again with Refresh from GitHub in the sidebar.",
        )}
      </Note>
    );
  }
  return <Note>{t("読み込み中…", "Loading…")}</Note>;
}

function GrowthGraph({ growth }: { growth: Growth }) {
  const { times, series } = growth;
  if (times.length === 0 || series.length === 0) {
    return <Note>{t("まだ記録がありません。", "No history yet.")}</Note>;
  }
  const end = Math.max(Date.now(), times[times.length - 1]!);
  const start = Math.min(times[0]!, end - DAY_MS);
  const totals = times.map((_, k) => series.reduce((sum, s) => sum + s.values[k]!, 0));
  // 目盛りは KB か MB の切りのよい数（10MB、20MB …）にする
  const peak = Math.max(...totals);
  const unit = peak >= 1024 * 1024 ? 1024 * 1024 : 1024;
  const max = niceMax(peak / unit) * unit;
  const plotW = G_WIDTH - G_LEFT - G_RIGHT;
  const plotH = G_HEIGHT - G_TOP - G_BOTTOM;
  const x = (time: number) => G_LEFT + ((time - start) / (end - start)) * plotW;
  const y = (v: number) => G_TOP + plotH - (v / max) * plotH;
  // 量はコミットした時点で変わるので、階段の形にする（最後の時点から今までは横ばい）
  const steps = (values: number[]): [number, number][] => {
    const pts: [number, number][] = [];
    values.forEach((v, k) => {
      if (k > 0) pts.push([x(times[k]!), y(values[k - 1]!)]);
      pts.push([x(times[k]!), y(v)]);
    });
    pts.push([x(end), y(values[values.length - 1]!)]);
    return pts;
  };
  const xy = ([px, py]: [number, number]) => `${px.toFixed(1)},${py.toFixed(1)}`;
  let below = times.map(() => 0);
  const areas = series.map((s, i) => {
    const above = below.map((v, k) => v + s.values[k]!);
    const upper = steps(above);
    const lower = steps(below).reverse();
    below = above;
    return {
      key: s.folder ?? "(other)",
      color: seriesColor(s.folder, i),
      gradient: `vw-growth-gradient-${i}`,
      d: `M${upper.map(xy).join("L")}L${lower.map(xy).join("L")}Z`,
      edge: `M${upper.map(xy).join("L")}`,
      title: `${folderName(s.folder)}: ${formatSize(s.values[s.values.length - 1]!)}`,
    };
  });
  const summary = t(
    `ノート ${notesCount(growth.totalNotes)}・合計 ${formatSize(growth.totalBytes)}`,
    `${notesCount(growth.totalNotes)}, ${formatSize(growth.totalBytes)} in total`,
  );
  return (
    <div>
      <p className="vw-home-summary">
        {summary}
        {t(
          `（${localDayFormat.format(new Date(times[0]!))}から。フォルダごとのノートの量）`,
          ` since ${localDayFormat.format(new Date(times[0]!))}, by folder`,
        )}
      </p>
      <svg
        className="vw-growth"
        viewBox={`0 0 ${G_WIDTH} ${G_HEIGHT}`}
        role="img"
        aria-label={summary}
      >
        {/* qkitzero/github-contribution-growth-graph と同じく、上ほど濃く下ほど透ける塗りと、上の端の線 */}
        <defs>
          {areas.map((a) => (
            <linearGradient
              key={a.gradient}
              id={a.gradient}
              gradientUnits="userSpaceOnUse"
              x1={0}
              x2={0}
              y1={G_TOP}
              y2={G_TOP + plotH}
            >
              <stop offset="0" stopColor={a.color} stopOpacity={0.69} />
              <stop offset="1" stopColor={a.color} stopOpacity={0.06} />
            </linearGradient>
          ))}
        </defs>
        <rect x={G_LEFT} y={G_TOP} width={plotW} height={plotH} className="vw-growth-plot" />
        {[0, max / 2, max].map((v) => (
          <g key={v}>
            <line x1={G_LEFT} x2={G_WIDTH - G_RIGHT} y1={y(v)} y2={y(v)} className="vw-growth-grid" />
            <text x={G_LEFT - 6} y={y(v) + 4} textAnchor="end" className="vw-graph-label">
              {formatSize(v)}
            </text>
          </g>
        ))}
        {monthTicks(start, end).map((time) => (
          <text key={time} x={x(time)} y={G_HEIGHT - 6} textAnchor="middle" className="vw-graph-label">
            {localMonthFormat.format(new Date(time))}
          </text>
        ))}
        {areas.map((a) => (
          <path key={a.key} d={a.d} fill={`url(#${a.gradient})`}>
            <title>{a.title}</title>
          </path>
        ))}
        {areas.map((a) => (
          <path key={a.key} d={a.edge} stroke={a.color} className="vw-growth-edge" />
        ))}
      </svg>
      <ul className="vw-growth-legend">
        {series.map((s, i) => (
          <li key={s.folder ?? "(other)"}>
            <span
              className="vw-growth-swatch"
              style={{ borderColor: seriesColor(s.folder, i) }}
              aria-hidden="true"
            />
            <span className="vw-growth-folder">{folderName(s.folder)}</span>
            <span className="vw-growth-size">
              {formatSize(s.values[s.values.length - 1]!)}
              {t("・", " · ")}
              {notesCount(s.notes)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- 知識マップ ---

const MAP_HEIGHT = 420;
/** 常に名前を出す、つながりの多いノートの数 */
const LABELED = 20;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

type MapState =
  | { kind: "loading" }
  | { kind: "indexing" }
  | { kind: "empty" }
  | { kind: "error" }
  | { kind: "ready"; notes: number; links: number };

function KnowledgeMap({
  client,
  version,
  full,
  onClose,
}: {
  client: Client;
  version: number;
  /** 画面いっぱいに広げているか */
  full: boolean;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const fullRef = useRef(full);
  fullRef.current = full;
  const [state, setState] = useState<MapState>({ kind: "loading" });

  useEffect(() => {
    let disposed = false;
    let graph: any;
    let observer: ResizeObserver | undefined;
    const el = container.current;
    // 2本指（ピンチ、Ctrl+ホイール）でだけ拡大する。ふつうのスクロールはページを動かす。
    // 画面いっぱいに広げているときは、ふつうのスクロールでも拡大する
    const onWheel = (e: WheelEvent) => {
      if (!fullRef.current && !e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    el?.addEventListener("wheel", onWheel, { capture: true });

    void (async () => {
      if (!el) return;
      if (!(await client.objectIndex.isIndexAvailable())) {
        setState({ kind: "indexing" });
        return;
      }
      const [pages, relations] = await Promise.all([
        client.queryLuaObjects<MapPage>("page", {}),
        client.queryLuaObjects<MapRelation>("relation", {}),
      ]);
      const data = buildKnowledgeMap(pages, relations);
      if (disposed) return;
      if (data.nodes.length === 0) {
        setState({ kind: "empty" });
        return;
      }
      // 描くための部品（force-graph）は大きいので、ホームを開いたときに読む
      const { default: ForceGraphImpl } = await import("force-graph");
      if (disposed) return;
      const ForceGraph = ForceGraphImpl as unknown as () => (element: HTMLElement) => any;
      const style = getComputedStyle(el);
      const color = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
      const accent = color("--ui-accent-color", "#7f6df2");
      const muted = color("--subtle-color", "#ababab");
      const text = color("--root-color", "#222");
      const line = color("--meta-subtle-color", "#ababab");
      const labeled = new Set(
        [...data.nodes]
          .filter((n) => n.degree > 0)
          .sort((a, b) => b.degree - a.degree)
          .slice(0, LABELED)
          .map((n) => n.id),
      );
      el.replaceChildren();
      // 描き終わるまで箱は隠しているので、幅は外側の箱で測る
      const width = () => el.clientWidth || el.parentElement?.clientWidth || 600;
      const height = () => (fullRef.current ? el.clientHeight || window.innerHeight : MAP_HEIGHT);
      graph = ForceGraph()(el)
        .width(width())
        .height(height())
        .backgroundColor("rgba(0,0,0,0)")
        .graphData({
          nodes: data.nodes.map((n) => ({ ...n })),
          links: data.links.map((l) => ({ ...l })),
        })
        .nodeId("id")
        .nodeRelSize(3)
        .nodeVal((n: MapNode) => 1 + n.degree)
        .nodeColor((n: MapNode) => (n.degree > 0 ? accent : muted))
        .nodeLabel((n: MapNode) => escapeHtml(n.id))
        .linkColor(() => line)
        .linkWidth(1.2)
        .cooldownTicks(150)
        .onNodeClick((n: MapNode) =>
          void client.navigate({ path: `${n.id}.md` }),
        )
        .nodeCanvasObjectMode(() => "after")
        .nodeCanvasObject((n: MapNode & { x: number; y: number }, ctx: CanvasRenderingContext2D, scale: number) => {
          const radius = knowledgeMapNodeRadius(n.degree, scale);
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = n.degree > 0 ? accent : muted;
          ctx.fill();
          if (!labeled.has(n.id) && scale < 2.5) return;
          const size = 11 / scale;
          ctx.font = `${size}px ${style.fontFamily}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = text;
          ctx.fillText(n.label, n.x, n.y + radius + 2 / scale);
        })
        .nodePointerAreaPaint((n: MapNode & { x: number; y: number }, hitColor: string, ctx: CanvasRenderingContext2D, scale: number) => {
          ctx.beginPath();
          ctx.arc(n.x, n.y, knowledgeMapNodeRadius(n.degree, scale) + 1 / scale, 0, Math.PI * 2);
          ctx.fillStyle = hitColor;
          ctx.fill();
        });
      let fitted = false;
      graph.onEngineStop(() => {
        if (fitted) return;
        fitted = true;
        graph.zoomToFit(400, 24);
      });
      graphRef.current = graph;
      observer = new ResizeObserver(() => graph?.width(width()).height(height()));
      observer.observe(el);
      setState({ kind: "ready", notes: data.nodes.length, links: data.links.length });
    })().catch((e) => {
      console.error("[vault-web] knowledge map", e);
      if (!disposed) setState({ kind: "error" });
    });

    return () => {
      disposed = true;
      el?.removeEventListener("wheel", onWheel, { capture: true });
      observer?.disconnect();
      graph?._destructor?.();
      graphRef.current = null;
    };
  }, [version]);

  // 広げたとき・戻したときに、全体が収まるように合わせ直す。Esc で閉じる
  useEffect(() => {
    const el = container.current;
    const graph = graphRef.current;
    if (el && graph) {
      graph.width(el.clientWidth).height(full ? el.clientHeight : MAP_HEIGHT);
      graph.zoomToFit(400, 24);
    }
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [full]);

  const ready = state.kind === "ready";
  return (
    <div
      className={full && ready ? "vw-knowledge-map-full" : undefined}
      role={full && ready ? "dialog" : undefined}
      aria-label={full && ready ? t("知識マップ", "Knowledge map") : undefined}
    >
      {full && ready && (
        <div className="vw-knowledge-map-full-bar">
          <span>{t("知識マップ", "Knowledge map")}</span>
          <button type="button" className="vw-home-link-button" onClick={onClose}>
            {t("閉じる", "Close")}
          </button>
        </div>
      )}
      {ready && !full && (
        <p className="vw-home-summary">
          {t(
            `ノート ${state.notes}件、つながり ${state.links}本。点を押すとノートを開きます。`,
            `${state.notes} notes, ${state.links} links. Click a dot to open the note.`,
          )}
        </p>
      )}
      {state.kind === "loading" && <Note>{t("読み込み中…", "Loading…")}</Note>}
      {state.kind === "indexing" && (
        <Note>
          {t(
            "ノートの索引を作成しています。完了すると表示されます。",
            "Indexing your notes. The map will appear when it's done.",
          )}
        </Note>
      )}
      {state.kind === "empty" && <Note>{t("ノートがまだありません。", "No notes yet.")}</Note>}
      {state.kind === "error" && (
        <Note>{t("知識マップを表示できませんでした。", "Couldn't display the knowledge map.")}</Note>
      )}
      <div
        ref={container}
        className="vw-knowledge-map"
        style={{ display: ready ? undefined : "none" }}
      />
    </div>
  );
}
