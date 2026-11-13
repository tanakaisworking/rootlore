// vault-web: .base ファイル（Obsidian の Bases）を開いたときの画面。ノートの一覧を表で出す（読み取り専用）。
// 中身の解釈は vault_web_base.ts。ここは索引からノートを集めて、表・タブ・お知らせ・元の YAML を描く。
// content_manager.ts から、画像などと同じく本文（CodeMirror）の代わりに出す。

import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { encodePageURI, type Ref } from "@silverbulletmd/silverbullet/lib/ref";
import type { DocumentMeta } from "@silverbulletmd/silverbullet/type/index";
import type { Client } from "./client.ts";
import type { ActiveDocumentEditor } from "./document_editor.ts";
import {
  type BaseFile,
  BaseParseError,
  type BaseRow,
  buildTable,
  cellText,
  parseBase,
  rowFromPage,
} from "./vault_web_base.ts";
import { t } from "./vault_web_i18n.ts";

export class BaseDocumentViewer implements ActiveDocumentEditor {
  readonly name = "BaseViewer";
  readonly needsBytes = true;
  extension = "base";
  private container?: HTMLElement;

  constructor(
    readonly parent: HTMLElement,
    readonly client: Client,
  ) {}

  openFile(data: Uint8Array | undefined, meta: DocumentMeta, _details: Ref["details"]): void {
    this.extension = meta.extension.toLowerCase();
    if (!this.container) {
      this.container = document.createElement("div");
      this.container.className = "vw-base-viewer";
      this.parent.appendChild(this.container);
    }
    this.parent.classList.add("hide-cm");
    const source = data ? new TextDecoder().decode(data) : "";
    render(
      <BaseView key={`${meta.name}:${meta.lastModified}`} client={this.client} name={meta.name} source={source} />,
      this.container,
    );
  }

  requestSave(): Promise<void> {
    return Promise.resolve();
  }

  focus(): void {
    this.container?.querySelector<HTMLElement>("button, a")?.focus();
  }

  updateTheme(): void {}

  destroy(): void {
    if (this.container) {
      render(null, this.container);
      this.container.remove();
    }
    this.container = undefined;
    this.parent.classList.remove("hide-cm");
  }
}

type LoadState = { kind: "loading" } | { kind: "indexing" } | { kind: "ready"; rows: BaseRow[] } | { kind: "error" };

/** 索引から、ノート（同梱の Library/ とテンプレートなどの meta を除く）と、ノートからのリンクを集める */
async function loadRows(client: Client): Promise<BaseRow[]> {
  const [pages, relations] = await Promise.all([
    client.queryLuaObjects<Record<string, unknown>>("page", {}),
    client.queryLuaObjects<{ page?: string; to?: string; toTag?: string; kind?: string }>("relation", {}),
  ]);
  const links = new Map<string, string[]>();
  for (const relation of relations) {
    if (!relation.page || !relation.to || relation.kind === "co-mention" || relation.toTag === "url") continue;
    const list = links.get(relation.page) ?? [];
    list.push(relation.to);
    links.set(relation.page, list);
  }
  const rows: BaseRow[] = [];
  for (const page of pages) {
    const row = rowFromPage(page, links);
    if (!row || row.name.startsWith("Library/")) continue;
    if (row.tags.some((tag) => tag === "template" || tag === "meta" || tag.startsWith("meta/"))) continue;
    rows.push(row);
  }
  return rows;
}

function BaseView({ client, name, source }: { client: Client; name: string; source: string }) {
  const parsed = useMemo((): { base: BaseFile } | { error: string } => {
    try {
      return { base: parseBase(source) };
    } catch (error) {
      return { error: error instanceof BaseParseError ? error.message : String(error) };
    }
  }, [source]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [viewIndex, setViewIndex] = useState(0);
  const [showSource, setShowSource] = useState(false);

  const broken = "error" in parsed;
  useEffect(() => {
    // 読めないファイルなら、ノートは集めない
    if (broken) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (disposed) return;
      try {
        // 索引ができるまでは待つ（初めて開いたときなど）
        if (!(await client.objectIndex.isIndexAvailable())) {
          if (disposed) return;
          setState({ kind: "indexing" });
          timer = setTimeout(load, 1500);
          return;
        }
        const rows = await loadRows(client);
        if (!disposed) setState({ kind: "ready", rows });
      } catch (error) {
        console.error("Could not load notes for the base", error);
        if (!disposed) setState({ kind: "error" });
      }
    };
    void load();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, broken]);

  const title = name.slice(name.lastIndexOf("/") + 1).replace(/\.base$/i, "");
  const sourceToggle = (
    <button type="button" className="vw-base-source-toggle" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
      {showSource ? t("表に戻る", "Back to table") : t("元のファイルを見る", "View source")}
    </button>
  );

  // 表は、ビューか読み込んだノートが変わったときだけ作り直す（フックは早めの return より前に置く）
  const okBase = "error" in parsed ? undefined : parsed.base;
  const activeView = okBase?.views[Math.min(viewIndex, okBase.views.length - 1)];
  const table = useMemo(
    () => (okBase && activeView && state.kind === "ready" ? buildTable(okBase, activeView, state.rows) : undefined),
    [okBase, activeView, state],
  );

  if ("error" in parsed) {
    return (
      <div className="vw-base">
        <header className="vw-base-header">
          <h1>{title}</h1>
        </header>
        <div className="vw-base-notice vw-base-notice-error" role="alert">
          <p>{t("このファイルを読み込めませんでした。書き方に誤りがあります。", "This file could not be read. It contains a syntax error.")}</p>
          <p className="vw-base-notice-detail">{parsed.error}</p>
        </div>
        <pre className="vw-base-source">{source}</pre>
      </div>
    );
  }

  const { base } = parsed;
  const view = base.views[Math.min(viewIndex, base.views.length - 1)]!;
  const unsupported = [...base.unsupported, ...view.unsupported];

  return (
    <div className="vw-base">
      <header className="vw-base-header">
        <h1>{title}</h1>
        {sourceToggle}
      </header>
      {showSource ? (
        <pre className="vw-base-source">{source}</pre>
      ) : (
        <>
          {base.views.length > 1 && (
            <div className="vw-base-tabs" role="tablist" aria-label={t("ビュー", "Views")}>
              {base.views.map((v, i) => (
                <button
                  key={`${i}:${v.name}`}
                  type="button"
                  role="tab"
                  aria-selected={i === viewIndex}
                  className={i === viewIndex ? "vw-base-tab is-active" : "vw-base-tab"}
                  onClick={() => setViewIndex(i)}
                >
                  {v.name}
                </button>
              ))}
            </div>
          )}
          {view.type !== "table" && (
            <p className="vw-base-notice" role="status">
              {t(
                `このビュー（${view.type}）は、まだ表でしか表示できません。表で表示しています。`,
                `This view (${view.type}) isn't supported yet, so it's shown as a table.`,
              )}
            </p>
          )}
          {unsupported.length > 0 && (
            <details className="vw-base-notice">
              <summary>
                {t(
                  `対応していない項目が ${unsupported.length} 件あります。これらは使わずに表示しています。`,
                  `${unsupported.length} ${unsupported.length === 1 ? "item isn't" : "items aren't"} supported yet and ${unsupported.length === 1 ? "was" : "were"} skipped.`,
                )}
              </summary>
              <ul>
                {unsupported.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          )}
          {state.kind === "loading" && <p className="vw-base-status">{t("読み込み中…", "Loading…")}</p>}
          {state.kind === "indexing" && (
            <p className="vw-base-status">{t("ノートの索引を作っています。できしだい表示します。", "Indexing your notes. The table will appear when it's done.")}</p>
          )}
          {state.kind === "error" && (
            <p className="vw-base-status" role="alert">
              {t("ノートを読み込めませんでした。開き直してください。", "Your notes could not be loaded. Try opening the file again.")}
            </p>
          )}
          {table && (
            <>
              <p className="vw-base-count">
                {table.total === table.groups.reduce((n, g) => n + g.rows.length, 0)
                  ? t(`${table.total} 件のノート`, `${table.total} ${table.total === 1 ? "note" : "notes"}`)
                  : t(
                      `${table.total} 件のうち ${table.groups.reduce((n, g) => n + g.rows.length, 0)} 件を表示`,
                      `Showing ${table.groups.reduce((n, g) => n + g.rows.length, 0)} of ${table.total} notes`,
                    )}
              </p>
              {table.total === 0 ? (
                <p className="vw-base-status">{t("この条件に合うノートはありません。", "No notes match this view.")}</p>
              ) : (
                <div className="vw-base-table-wrap">
                  <table className="vw-base-table">
                    <thead>
                      <tr>
                        {table.columns.map((column) => (
                          <th key={column.property} scope="col">
                            {column.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    {table.groups.map((group, groupIndex) => (
                      <tbody key={`${groupIndex}:${group.label ?? ""}`}>
                        {group.label !== undefined && (
                          <tr className="vw-base-group">
                            <th scope="colgroup" colSpan={table.columns.length}>
                              {group.label}
                              <span className="vw-base-group-count">{group.rows.length}</span>
                            </th>
                          </tr>
                        )}
                        {group.rows.map((row) => (
                          <tr key={row.name}>
                            {table.columns.map((column, columnIndex) => (
                              <td key={column.property}>
                                {columnIndex === 0 ? (
                                  <a
                                    href={`/${encodePageURI(row.name)}`}
                                    className="vw-base-link"
                                    onClick={(e) => {
                                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                                      e.preventDefault();
                                      void client.navigate({ path: `${row.name}.md` });
                                    }}
                                  >
                                    {cellText(row, column.property) || cellText(row, "file.name")}
                                  </a>
                                ) : (
                                  cellText(row, column.property)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
