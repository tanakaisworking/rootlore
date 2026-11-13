// vault-web: ホームの草のグラフ（更新の記録）の元になる数と、グラフの目盛り。
// GitHub の /stats/commit_activity（過去52週の、曜日ごとのコミット数。週は日曜はじまり、UTC）から作る。

export type ActivityWeek = {
  /** 週のはじめ（日曜 0 時、UTC）の Unix 秒 */
  week: number;
  /** 日曜から土曜までのコミット数 */
  days: number[];
  total: number;
};

export type ActivityDay = {
  /** UTC の日付（YYYY-MM-DD） */
  date: string;
  count: number;
  /** 何週目か（左の列が 0） */
  column: number;
  /** 曜日（日曜が 0） */
  row: number;
  /** 色の濃さ。0（なし）〜4 */
  level: number;
};

const DAY = 86400;

/** 今日より先の日（今週の残り）は入れない */
export function activityDays(weeks: ActivityWeek[], now: number): ActivityDay[] {
  const today = Math.floor(now / 1000 / DAY);
  const days: Omit<ActivityDay, "level">[] = [];
  weeks.forEach((w, column) => {
    w.days.forEach((count, row) => {
      const seconds = w.week + row * DAY;
      if (Math.floor(seconds / DAY) > today) return;
      days.push({
        date: new Date(seconds * 1000).toISOString().slice(0, 10),
        count,
        column,
        row,
      });
    });
  });
  const max = Math.max(0, ...days.map((d) => d.count));
  return days.map((d) => ({
    ...d,
    // GitHub の草と同じく、いちばん多い日を 4 として4段階に分ける
    level: d.count === 0 ? 0 : Math.max(1, Math.ceil((d.count / max) * 4)),
  }));
}

/** 目盛りにちょうどよい上限（1, 2, 5, 10, 20, 50 …） */
export function niceMax(value: number): number {
  if (value <= 1) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 5, 10]) {
    if (value <= m * step) return m * step;
  }
  return 10 * step;
}
