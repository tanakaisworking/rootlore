// vault-web: ホームの「成長の記録」。フォルダごとのノートの量（バイト数）が、どう増えたか。
// コミットごとの、その時点のファイルの一覧（git/trees/{sha}?recursive=1）から作る。一覧はその時点の全体なので、
// 消したファイルは次の一覧からなくなり、名前やフォルダを変えたファイルは新しい場所で数えられる。
// 差分（コミットの詳細）は大きなコミットで数MBになるので使わない。

export type CommitRef = {
  /** コミットした日時（ISO） */
  date: string;
  /** その時点のファイルの一覧の SHA */
  tree: string;
};

export type TreeEntry = { path: string; type: string; size?: number };

export type FolderSize = { bytes: number; notes: number };

export type Snapshot = { time: number; folders: Map<string, FolderSize> };

export type GrowthSeries = {
  /** いちばん上のフォルダの名前。"" はフォルダの外、null は「その他」 */
  folder: string | null;
  /** 時点ごとのバイト数 */
  values: number[];
  /** 最後の時点のノートの数 */
  notes: number;
};

export type Growth = {
  /** 時点（ミリ秒） */
  times: number[];
  series: GrowthSeries[];
  totalBytes: number;
  totalNotes: number;
};

const localDay = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

/**
 * 1日に何回コミットしても、その日の最後の1回だけを使う。古い順に並べ、多すぎるときは
 * 最初と最後を残して等間隔に間引く（ファイルの一覧を読む回数を max までにする）
 */
export function pickSnapshots(commits: CommitRef[], max: number): CommitRef[] {
  const lastOfDay = new Map<string, CommitRef>();
  const sorted = [...commits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const c of sorted) lastOfDay.set(localDay(new Date(c.date)), c);
  const days = [...lastOfDay.values()];
  if (days.length <= max) return days;
  const picked: CommitRef[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(days[Math.round((i * (days.length - 1)) / (max - 1))]!);
  }
  return picked;
}

/** ノート（.md）をいちばん上のフォルダごとに合計する。「.」で始まるフォルダ（.trash など）は数えない */
export function folderSizes(entries: TreeEntry[]): Map<string, FolderSize> {
  const folders = new Map<string, FolderSize>();
  for (const e of entries) {
    if (e.type !== "blob" || !e.path.endsWith(".md")) continue;
    const parts = e.path.split("/");
    if (parts.some((p) => p.startsWith("."))) continue;
    const folder = parts.length > 1 ? parts[0]! : "";
    const f = folders.get(folder) ?? { bytes: 0, notes: 0 };
    f.bytes += e.size ?? 0;
    f.notes += 1;
    folders.set(folder, f);
  }
  return folders;
}

/** 今いちばん大きいフォルダから top 個を、ほかは「その他」にまとめる。今はないフォルダも「その他」 */
export function buildGrowth(snapshots: Snapshot[], top: number): Growth {
  const last = snapshots[snapshots.length - 1]?.folders ?? new Map<string, FolderSize>();
  const ranked = [...last.entries()]
    .filter(([, f]) => f.bytes > 0)
    .sort((a, b) => b[1].bytes - a[1].bytes);
  // 「その他」にまとめるのが1つだけなら、そのまま出す
  const named = ranked.length === top + 1 ? ranked : ranked.slice(0, top);
  const names = new Set(named.map(([name]) => name));
  const series: GrowthSeries[] = named.map(([folder, f]) => ({
    folder,
    values: snapshots.map((s) => s.folders.get(folder)?.bytes ?? 0),
    notes: f.notes,
  }));
  const other = snapshots.map((s) =>
    [...s.folders].reduce((sum, [name, f]) => (names.has(name) ? sum : sum + f.bytes), 0),
  );
  if (other.some((v) => v > 0)) {
    series.push({
      folder: null,
      values: other,
      notes: [...last].reduce((sum, [name, f]) => (names.has(name) ? sum : sum + f.notes), 0),
    });
  }
  return {
    times: snapshots.map((s) => s.time),
    series,
    totalBytes: [...last.values()].reduce((sum, f) => sum + f.bytes, 0),
    totalNotes: [...last.values()].reduce((sum, f) => sum + f.notes, 0),
  };
}
