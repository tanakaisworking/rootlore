// vault-web: 保存しようとしたノートが GitHub 側で先に変わっていたときに、行単位の3方向マージでまとめる。
// 同じ箇所が両方で変わっていたら、git と同じ区切りの行で両方を残す。エディターがそれを見つけて、
// どちらを残すか選ぶ表示に変える（client/codemirror/conflict_markers.ts）。

import { diffArrays } from "diff";

export const mineLabel = "この端末の変更";
export const theirsLabel = "GitHub の変更";
const startLine = `<<<<<<< ${mineLabel}`;
const endLine = `>>>>>>> ${theirsLabel}`;
/** 比べる量の上限（追加と削除の行数）。超えたら、その範囲を丸ごとぶつかったことにして両方を残す */
const maxEditLength = 2000;

export type MergeOutcome = { text: string; conflicts: number };

/**
 * base から mine（この端末）と theirs（GitHub）に分かれた本文をまとめる。
 * 行の比べ方は jsdiff（Myers）で、比べる量に上限を付ける。まとめ方は node-diff3 の diff3MergeRegions と同じ。
 * 行の多いノートでも落ちないよう、配列を引数に展開しない
 */
export function mergeText(base: string, mine: string, theirs: string): MergeOutcome {
  if (mine === theirs || theirs === base) return { text: mine, conflicts: 0 };
  if (mine === base) return { text: theirs, conflicts: 0 };
  const a = mine.split("\n");
  const o = base.split("\n");
  const b = theirs.split("\n");
  // 3つに共通する先頭と末尾の行は、比べるまでもなくそのまま残る
  let head = 0;
  while (head < a.length && head < o.length && head < b.length && a[head] === o[head] && b[head] === o[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < o.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === o[o.length - 1 - tail] &&
    b[b.length - 1 - tail] === o[o.length - 1 - tail]
  ) {
    tail++;
  }
  const lines: string[] = [];
  const append = (from: readonly string[], start: number, end: number) => {
    for (let i = start; i < end; i++) lines.push(from[i]!);
  };
  append(o, 0, head);
  const conflicts = mergeRegions(
    a.slice(head, a.length - tail),
    o.slice(head, o.length - tail),
    b.slice(head, b.length - tail),
    lines,
  );
  append(o, o.length - tail, o.length);
  return { text: lines.join("\n"), conflicts };
}

/** base の [oStart, oEnd) が、その側の [start, end) に変わった */
type Hunk = { side: 0 | 1; oStart: number; oEnd: number; start: number; end: number };

function hunksOf(side: 0 | 1, o: string[], x: string[]): Hunk[] {
  const parts = diffArrays(o, x, { maxEditLength });
  // 違いが多すぎて比べきれない。全体を1つの変更とみなす
  if (!parts) return [{ side, oStart: 0, oEnd: o.length, start: 0, end: x.length }];
  const hunks: Hunk[] = [];
  let oIndex = 0;
  let xIndex = 0;
  let open: Hunk | undefined;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      open = undefined;
      oIndex += part.count;
      xIndex += part.count;
      continue;
    }
    if (!open) {
      open = { side, oStart: oIndex, oEnd: oIndex, start: xIndex, end: xIndex };
      hunks.push(open);
    }
    if (part.removed) {
      oIndex += part.count;
      open.oEnd = oIndex;
    } else {
      xIndex += part.count;
      open.end = xIndex;
    }
  }
  return hunks;
}

/** mine（a）と theirs（b）の変更を base（o）の上で重ね、lines に足す。ぶつかった数を返す */
function mergeRegions(a: string[], o: string[], b: string[], lines: string[]): number {
  const sides = [a, b] as const;
  const hunks = [...hunksOf(0, o, a), ...hunksOf(1, o, b)].sort((x, y) => x.oStart - y.oStart);
  const append = (from: readonly string[], start: number, end: number) => {
    for (let i = start; i < end; i++) lines.push(from[i]!);
  };
  // 各側の、base からの行のずれ（ここまでの変更で増えた行数）
  const shift = [0, 0];
  let cursor = 0;
  let conflicts = 0;
  for (let i = 0; i < hunks.length; ) {
    const regionStart = hunks[i]!.oStart;
    let regionEnd = hunks[i]!.oEnd;
    let j = i + 1;
    while (j < hunks.length && hunks[j]!.oStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[j]!.oEnd);
      j++;
    }
    const group = hunks.slice(i, j);
    append(o, cursor, regionStart);
    if (group.length === 1) {
      const hunk = group[0]!;
      append(sides[hunk.side], hunk.start, hunk.end);
    } else {
      // 両方の側の変更が重なった。それぞれの側で、この範囲が何行になったかを求める
      const ranges = ([0, 1] as const).map((side) => {
        const own = group.filter((hunk) => hunk.side === side);
        if (!own.length) return [regionStart + shift[side]!, regionEnd + shift[side]!] as const;
        const first = own[0]!;
        const last = own[own.length - 1]!;
        return [first.start - (first.oStart - regionStart), last.end + (regionEnd - last.oEnd)] as const;
      });
      const [aStart, aEnd] = ranges[0]!;
      const [bStart, bEnd] = ranges[1]!;
      if (sameRange(a, aStart, aEnd, b, bStart, bEnd)) {
        // 両方で同じ変更をした
        append(a, aStart, aEnd);
      } else {
        conflicts++;
        lines.push(startLine);
        append(a, aStart, aEnd);
        lines.push("=======");
        append(b, bStart, bEnd);
        lines.push(endLine);
      }
    }
    for (const hunk of group) shift[hunk.side]! += hunk.end - hunk.start - (hunk.oEnd - hunk.oStart);
    cursor = regionEnd;
    i = j;
  }
  append(o, cursor, o.length);
  return conflicts;
}

function sameRange(
  x: readonly string[],
  xStart: number,
  xEnd: number,
  y: readonly string[],
  yStart: number,
  yEnd: number,
): boolean {
  if (xEnd - xStart !== yEnd - yStart) return false;
  for (let i = 0; i < xEnd - xStart; i++) {
    if (x[xStart + i] !== y[yStart + i]) return false;
  }
  return true;
}

/**
 * mergeText が残した区切りが、まだ本文にあるか（選び終わるまでは保存しない）。
 * 手で直している途中で片方だけ残ることもあるので、どちらか1つでもあれば残っているとみなす。
 * 「=======」は Markdown の見出しにも使うので見ない
 */
export function hasMergeConflict(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.includes(startLine) || lines.includes(endLine);
}
