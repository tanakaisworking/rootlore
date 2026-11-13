// vault-web: ホームの知識マップ（ノートどうしのリンクのつながり）の点と線を作る。
// 元の索引（page と relation）を使う。描くのは components/vault_web_home_view.tsx（force-graph）。

export type MapPage = { name?: string; tag?: string; tags?: string[] };

export type MapRelation = {
  page?: string;
  to?: string;
  toTag?: string;
  kind?: string;
};

export type MapNode = { id: string; label: string; degree: number };
export type MapLink = { source: string; target: string };

/** 全体表示でも点を画面上の半径1.5px以上に保つ。Safariでのサブピクセルの消失を防ぐ。 */
export function knowledgeMapNodeRadius(degree: number, scale: number): number {
  return Math.max(Math.sqrt(1 + degree) * 3, (degree > 0 ? 2.5 : 1.5) / scale);
}

function isHidden(page: MapPage, name: string): boolean {
  // 同梱のページ（Library/）、テンプレートなどの meta のページは、ノートではないので出さない
  if (name.startsWith("Library/")) return true;
  return (page.tags ?? []).some(
    (tag) => tag === "template" || tag === "meta" || tag.startsWith("meta/"),
  );
}

const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1);

export function buildKnowledgeMap(
  pages: MapPage[],
  relations: MapRelation[],
): { nodes: MapNode[]; links: MapLink[] } {
  const names = new Set<string>();
  for (const p of pages) {
    const name = p.name;
    if (name && !isHidden(p, name)) names.add(name);
  }
  // Obsidian の [[名前]] はフォルダを省けるので、名前が1つのノートにだけ当たるなら、それにつなぐ
  const byBase = new Map<string, string | null>();
  for (const name of names) {
    const base = baseName(name);
    byBase.set(base, byBase.has(base) ? null : name);
  }
  const resolve = (to: string): string | undefined => {
    const name = to.split(/[@#$]/)[0]!;
    if (names.has(name)) return name;
    return byBase.get(name) ?? undefined;
  };

  const degree = new Map<string, number>();
  const seen = new Set<string>();
  const links: MapLink[] = [];
  for (const r of relations) {
    if (r.kind === "co-mention" || r.toTag !== "page" || !r.page || !r.to) {
      continue;
    }
    const source = r.page;
    const target = resolve(r.to);
    if (!names.has(source) || !target || target === source) continue;
    // 向きは見ない（A→B と B→A は1本）
    const key = source < target ? `${source}\n${target}` : `${target}\n${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source, target });
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  }

  const nodes = [...names].map((id) => ({
    id,
    label: baseName(id),
    degree: degree.get(id) ?? 0,
  }));
  return { nodes, links };
}
