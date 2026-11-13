// vault-web: Obsidian の Bases（.base ファイル）を読んで、ノートの一覧を表にするための中身。
// 画面は vault_web_base_viewer.tsx。ここは YAML の読み込み、条件の式の解釈、表の行と列づくりだけを持つ。
//
// 最初の版は読み取り専用。対応していない書き方（式 formulas、集計 summaries、知らない関数など）は
// 止まらずに飛ばし、「対応していない項目」として画面に出す。
// 書き方は Obsidian の公開ヘルプを読んで、ここで一から書いた（Obsidian のコードは使っていない）。

import YAML from "js-yaml";
import { t } from "./vault_web_i18n.ts";

// --- 行（ノート1件） ---

export type BaseRow = {
  /** 索引のページ名（拡張子なし。例: Demo/Project plan） */
  name: string;
  /** frontmatter の値 */
  props: Record<string, unknown>;
  tags: string[];
  /** このノートからリンクしているページ名。分からなければ undefined */
  links?: string[];
  mtime?: Date;
  ctime?: Date;
  size?: number;
};

/** 索引のページから行をつくるときに、frontmatter として扱わない項目 */
const SYSTEM_KEYS = new Set([
  "ref",
  "tag",
  "tags",
  "itags",
  "name",
  "created",
  "lastModified",
  "perm",
  "lastOpened",
  "pageDecoration",
  "contentType",
  "size",
]);

/**
 * 日付にする。日付だけの書き方（2026-11-11）は、today() やファイルの日時とそろうように
 * その日のローカルの 0 時にする（Date.parse は UTC の 0 時にしてしまい、日本では 9 時間ずれる）
 */
function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    // YAML の日付（2026-11-11）は UTC の 0 時の Date になる。日付だけとみなしてローカルの 0 時にそろえる
    if (
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0
    ) {
      return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim() !== "") {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time);
  }
  return undefined;
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "");
}

/** 索引の page オブジェクトと、ノートからのリンク（ページ名 → リンク先）から行をつくる */
export function rowFromPage(
  page: Record<string, unknown>,
  links?: Map<string, string[]>,
): BaseRow | undefined {
  const name = typeof page.name === "string" ? page.name : undefined;
  if (!name) return undefined;
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(page)) {
    if (!SYSTEM_KEYS.has(key)) props[key] = value;
  }
  const rawTags = Array.isArray(page.tags) ? page.tags : [];
  return {
    name,
    props,
    tags: rawTags.filter((tag): tag is string => typeof tag === "string").map(normalizeTag),
    links: links ? (links.get(name) ?? []) : undefined,
    mtime: toDate(page.lastModified),
    ctime: toDate(page.created),
    size: typeof page.size === "number" ? page.size : undefined,
  };
}

const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1);
const folderOf = (name: string) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");

/** リンク先の書き方（[[x]]、x.md、x|別名）を、ページ名にそろえる */
function linkTarget(value: string): string {
  let target = value.trim();
  const wiki = /^\[\[(.*)\]\]$/.exec(target);
  if (wiki) target = wiki[1]!;
  target = target.split("|")[0]!.split("#")[0]!.trim();
  return target.replace(/\.md$/i, "");
}

// --- 式 ---
// 条件（filters）の文字列の式を、自前で読む（eval は使わない）。
// 対応: == != > < >= <= && || ! ( ) 、文字・数・真偽の値、プロパティ（status / note.status / file.*）、
// file.hasTag / inFolder / hasLink / hasProperty、date() / now() / today()

export class UnsupportedError extends Error {}

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string };

const OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "(", ")", ",", "+", "-", "*", "/", "%", "[", "]"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let value = "";
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\" && i + 1 < source.length) {
          value += source[i + 1];
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      if (i >= source.length) throw new SyntaxError("unterminated string");
      i++;
      tokens.push({ kind: "str", value });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(i))!;
      tokens.push({ kind: "num", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      const match = /^[\p{L}\p{N}_$]+(?:\.[\p{L}\p{N}_$]+)*/u.exec(source.slice(i))!;
      tokens.push({ kind: "ident", value: match[0] });
      i += match[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) throw new SyntaxError(`unexpected character ${c}`);
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }
  return tokens;
}

export type Expr =
  | { type: "literal"; value: unknown }
  | { type: "prop"; path: string }
  | { type: "call"; name: string; args: Expr[] }
  | { type: "not"; operand: Expr }
  | { type: "binary"; op: string; left: Expr; right: Expr };

const COMPARISONS = new Set(["==", "!=", ">", "<", ">=", "<="]);
const FUNCTIONS = new Set([
  "file.hasTag",
  "file.inFolder",
  "file.hasLink",
  "file.hasProperty",
  "date",
  "now",
  "today",
]);

/** 式を読む。対応していない書き方は UnsupportedError、壊れた式は SyntaxError */
export function parseExpression(source: string): Expr {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => {
    const token = peek();
    return token?.kind === "op" && token.value === value;
  };
  const expectOp = (value: string) => {
    if (!isOp(value)) throw new SyntaxError(`expected ${value}`);
    pos++;
  };

  function parseOr(): Expr {
    let left = parseAnd();
    while (isOp("||")) {
      pos++;
      left = { type: "binary", op: "||", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd(): Expr {
    let left = parseComparison();
    while (isOp("&&")) {
      pos++;
      left = { type: "binary", op: "&&", left, right: parseComparison() };
    }
    return left;
  }
  function parseComparison(): Expr {
    const left = parseUnary();
    const token = peek();
    if (token?.kind === "op" && COMPARISONS.has(token.value)) {
      pos++;
      return { type: "binary", op: token.value, left, right: parseUnary() };
    }
    if (token?.kind === "op" && ["+", "-", "*", "/", "%"].includes(token.value)) {
      throw new UnsupportedError(t(`計算（${token.value}）`, `Arithmetic (${token.value})`));
    }
    return left;
  }
  function parseUnary(): Expr {
    if (isOp("!")) {
      pos++;
      return { type: "not", operand: parseUnary() };
    }
    if (isOp("-")) {
      pos++;
      const operand = parseUnary();
      if (operand.type === "literal" && typeof operand.value === "number") {
        return { type: "literal", value: -operand.value };
      }
      throw new UnsupportedError(t("計算（-）", "Arithmetic (-)"));
    }
    return parsePrimary();
  }
  function parsePrimary(): Expr {
    const token = peek();
    if (!token) throw new SyntaxError("unexpected end");
    pos++;
    if (token.kind === "num" || token.kind === "str") return { type: "literal", value: token.value };
    if (token.kind === "op") {
      if (token.value === "(") {
        const inner = parseOr();
        expectOp(")");
        return inner;
      }
      if (token.value === "[") throw new UnsupportedError(t("リスト（[ ]）", "Lists ([ ])"));
      throw new SyntaxError(`unexpected ${token.value}`);
    }
    const name = token.value;
    if (name === "true" || name === "false") return { type: "literal", value: name === "true" };
    if (name === "null") return { type: "literal", value: null };
    if (isOp("(")) {
      pos++;
      const args: Expr[] = [];
      if (!isOp(")")) {
        args.push(parseOr());
        while (isOp(",")) {
          pos++;
          args.push(parseOr());
        }
      }
      expectOp(")");
      if (!FUNCTIONS.has(name)) throw new UnsupportedError(t(`関数 ${name}()`, `Function ${name}()`));
      return { type: "call", name, args };
    }
    if (isOp("[")) throw new UnsupportedError(t(`添字（${name}[…]）`, `Indexing (${name}[…])`));
    if (name === "this" || name.startsWith("this.")) {
      throw new UnsupportedError(t(`this（${name}）`, `this (${name})`));
    }
    if (name.startsWith("formula.")) throw new UnsupportedError(t(`式 ${name}`, `Formula ${name}`));
    if (name.startsWith("file.") && !FILE_PROPS.has(name)) {
      throw new UnsupportedError(t(`ファイルの項目 ${name}`, `File property ${name}`));
    }
    return { type: "prop", path: name };
  }

  const expr = parseOr();
  if (pos < tokens.length) throw new SyntaxError("unexpected trailing input");
  return expr;
}

const FILE_PROPS = new Set([
  "file.name",
  "file.basename",
  "file.path",
  "file.folder",
  "file.ext",
  "file.mtime",
  "file.ctime",
  "file.size",
  "file.tags",
  "file.links",
]);

/** プロパティの値。file.* はファイルの情報、それ以外（note.x、素の x）は frontmatter */
export function propertyValue(row: BaseRow, path: string): unknown {
  switch (path) {
    case "file.name":
      return `${baseName(row.name)}.md`;
    case "file.basename":
      return baseName(row.name);
    case "file.path":
      return `${row.name}.md`;
    case "file.folder":
      return folderOf(row.name);
    case "file.ext":
      return "md";
    case "file.mtime":
      return row.mtime;
    case "file.ctime":
      return row.ctime;
    case "file.size":
      return row.size;
    case "file.tags":
      return row.tags;
    case "file.links":
      return row.links;
  }
  const key = path.startsWith("note.") ? path.slice("note.".length) : path;
  if (key === "tags") return row.tags;
  if (Object.hasOwn(row.props, key)) return row.props[key];
  // 索引は frontmatter の「a.b: x」を入れ子（{ a: { b: x } }）にして持つので、点で区切ってたどる
  return nestedValue(row.props, key);
}

function nestedValue(props: Record<string, unknown>, key: string): unknown {
  if (!key.includes(".")) return undefined;
  let current: unknown = props;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringArg(row: BaseRow, arg: Expr | undefined): string | undefined {
  if (!arg) return undefined;
  const value = evaluate(arg, row);
  return value === undefined || value === null ? undefined : String(value);
}

function compareValues(a: unknown, b: unknown): number | undefined {
  if (a instanceof Date || b instanceof Date) {
    const x = toDate(a);
    const y = toDate(b);
    if (!x || !y) return undefined;
    return x.getTime() - y.getTime();
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a);
    const y = Number(b);
    if (a === null || b === null || a === undefined || b === undefined) return undefined;
    if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
    return x - y;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) return a.some((item) => looseEquals(item, b));
  if (Array.isArray(b)) return b.some((item) => looseEquals(a, item));
  const order = compareValues(a, b);
  if (order !== undefined) return order === 0;
  return String(a) === String(b);
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}

export function evaluate(expr: Expr, row: BaseRow): unknown {
  switch (expr.type) {
    case "literal":
      return expr.value;
    case "prop":
      return propertyValue(row, expr.path);
    case "not":
      return !truthy(evaluate(expr.operand, row));
    case "binary": {
      if (expr.op === "&&") return truthy(evaluate(expr.left, row)) && truthy(evaluate(expr.right, row));
      if (expr.op === "||") return truthy(evaluate(expr.left, row)) || truthy(evaluate(expr.right, row));
      const left = evaluate(expr.left, row);
      const right = evaluate(expr.right, row);
      if (expr.op === "==") return looseEquals(left, right);
      if (expr.op === "!=") return !looseEquals(left, right);
      const order = compareValues(left, right);
      if (order === undefined) return false;
      if (expr.op === ">") return order > 0;
      if (expr.op === "<") return order < 0;
      if (expr.op === ">=") return order >= 0;
      return order <= 0;
    }
    case "call":
      return callFunction(expr, row);
  }
}

function callFunction(expr: Extract<Expr, { type: "call" }>, row: BaseRow): unknown {
  switch (expr.name) {
    case "file.hasTag":
      return expr.args.some((arg) => {
        const tag = stringArg(row, arg);
        if (!tag) return false;
        const wanted = normalizeTag(tag);
        return row.tags.some((have) => have === wanted || have.startsWith(`${wanted}/`));
      });
    case "file.inFolder": {
      const folder = stringArg(row, expr.args[0])?.replace(/^\/+|\/+$/g, "");
      if (folder === undefined) return false;
      if (folder === "") return true;
      const own = folderOf(row.name);
      return own === folder || own.startsWith(`${folder}/`);
    }
    case "file.hasLink": {
      const target = stringArg(row, expr.args[0]);
      if (!target || !row.links) return false;
      const wanted = linkTarget(target);
      return row.links.some((link) => link === wanted || baseName(link) === wanted);
    }
    case "file.hasProperty": {
      const key = stringArg(row, expr.args[0]);
      if (!key) return false;
      const name = key.startsWith("note.") ? key.slice(5) : key;
      return Object.hasOwn(row.props, name) || nestedValue(row.props, name) !== undefined;
    }
    case "date":
      return toDate(evaluate(expr.args[0] ?? { type: "literal", value: undefined }, row));
    case "now":
      return new Date();
    case "today": {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
  }
  throw new UnsupportedError(expr.name);
}

// --- 条件（filters） ---

type Filter =
  | { kind: "expr"; expr: Expr }
  | { kind: "and" | "or" | "not"; items: Filter[] }
  /** 対応していない条件。and では「真」、or と not では無いものとして扱う */
  | { kind: "skip" };

function compileFilter(raw: unknown, unsupported: Set<string>): Filter {
  if (raw === undefined || raw === null) return { kind: "skip" };
  if (typeof raw === "string") {
    try {
      return { kind: "expr", expr: parseExpression(raw) };
    } catch (error) {
      unsupported.add(
        error instanceof UnsupportedError
          ? t(`条件「${raw}」（${error.message}）`, `Filter "${raw}" (${error.message})`)
          : t(`読めない条件「${raw}」`, `Unreadable filter "${raw}"`),
      );
      return { kind: "skip" };
    }
  }
  if (typeof raw === "boolean") return { kind: "expr", expr: { type: "literal", value: raw } };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>);
    const groups: Filter[] = [];
    for (const [key, value] of entries) {
      if (key === "and" || key === "or" || key === "not") {
        const list = Array.isArray(value) ? value : [value];
        groups.push({ kind: key, items: list.map((item) => compileFilter(item, unsupported)) });
      } else {
        unsupported.add(t(`条件の書き方「${key}」`, `Filter key "${key}"`));
      }
    }
    if (groups.length === 0) return { kind: "skip" };
    return groups.length === 1 ? groups[0]! : { kind: "and", items: groups };
  }
  unsupported.add(t("読めない条件", "Unreadable filter"));
  return { kind: "skip" };
}

/** 条件に合うか。対応していない条件しかないときは undefined（絞り込まない） */
function matches(filter: Filter, row: BaseRow): boolean | undefined {
  switch (filter.kind) {
    case "skip":
      return undefined;
    case "expr":
      try {
        return truthy(evaluate(filter.expr, row));
      } catch {
        return false;
      }
    case "and": {
      let any = false;
      for (const item of filter.items) {
        const result = matches(item, row);
        if (result === false) return false;
        if (result === true) any = true;
      }
      return any ? true : undefined;
    }
    case "or": {
      // 空の or は、何にも合わない。対応していない条件だけの or は、絞り込まない（undefined）
      if (filter.items.length === 0) return false;
      let any = false;
      for (const item of filter.items) {
        const result = matches(item, row);
        if (result === true) return true;
        if (result === false) any = true;
      }
      return any ? false : undefined;
    }
    case "not": {
      let any = false;
      for (const item of filter.items) {
        const result = matches(item, row);
        if (result === true) return false;
        if (result === false) any = true;
      }
      return any ? true : undefined;
    }
  }
}

// --- ファイル全体 ---

export type BaseView = {
  name: string;
  type: string;
  order: string[];
  limit?: number;
  groupBy?: { property: string; direction: "ASC" | "DESC" };
  sort: { property: string; direction: "ASC" | "DESC" }[];
  filter: Filter;
  /** このビューで対応していない項目 */
  unsupported: string[];
};

export type BaseFile = {
  filter: Filter;
  displayNames: Record<string, string>;
  views: BaseView[];
  /** ファイル全体で対応していない項目 */
  unsupported: string[];
};

export class BaseParseError extends Error {}

function direction(value: unknown): "ASC" | "DESC" {
  return String(value ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
}

/** プロパティの書き方をそろえる（note.status → status） */
export function normalizeProperty(property: string): string {
  return property.startsWith("note.") ? property.slice("note.".length) : property;
}

export function parseBase(source: string): BaseFile {
  let doc: unknown;
  try {
    doc = YAML.load(source);
  } catch (error) {
    throw new BaseParseError(error instanceof Error ? error.message : String(error));
  }
  if (doc === undefined || doc === null) doc = {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new BaseParseError(t("ファイルの一番上が、項目の並びになっていません", "The top level is not a set of keys"));
  }
  const raw = doc as Record<string, unknown>;
  const unsupported = new Set<string>();
  if (raw.formulas && typeof raw.formulas === "object") {
    for (const key of Object.keys(raw.formulas)) unsupported.add(t(`式 formula.${key}`, `Formula formula.${key}`));
  }
  if (raw.summaries) unsupported.add(t("集計（summaries）", "Summaries"));
  for (const key of Object.keys(raw)) {
    if (!["filters", "formulas", "properties", "summaries", "views"].includes(key)) {
      unsupported.add(t(`項目「${key}」`, `Key "${key}"`));
    }
  }
  const filter = compileFilter(raw.filters, unsupported);

  const displayNames: Record<string, string> = {};
  if (raw.properties && typeof raw.properties === "object") {
    for (const [key, value] of Object.entries(raw.properties as Record<string, unknown>)) {
      const name = (value as { displayName?: unknown } | null)?.displayName;
      if (typeof name === "string" && name.trim() !== "") displayNames[normalizeProperty(key)] = name;
    }
  }

  const rawViews = Array.isArray(raw.views) ? raw.views : [];
  const views: BaseView[] = rawViews
    .filter((view): view is Record<string, unknown> => !!view && typeof view === "object")
    .map((view, index) => {
      const viewUnsupported = new Set<string>();
      const order = Array.isArray(view.order)
        ? view.order.filter((p): p is string => typeof p === "string")
        : [];
      for (const property of order) {
        if (property.startsWith("formula.")) {
          viewUnsupported.add(t(`式の列 ${property}`, `Formula column ${property}`));
        } else if (property.startsWith("file.") && !FILE_PROPS.has(property)) {
          viewUnsupported.add(t(`ファイルの項目 ${property}`, `File property ${property}`));
        }
      }
      if (view.summaries) viewUnsupported.add(t("集計（summaries）", "Summaries"));
      const group = view.groupBy as { property?: unknown; direction?: unknown } | undefined;
      const sort = Array.isArray(view.sort)
        ? view.sort
            .filter((s): s is { property: string; direction?: unknown } =>
              !!s && typeof s === "object" && typeof (s as { property?: unknown }).property === "string",
            )
            .map((s) => ({ property: s.property, direction: direction(s.direction) }))
        : [];
      const limit = Number(view.limit);
      return {
        name: typeof view.name === "string" && view.name.trim() !== "" ? view.name : t(`ビュー ${index + 1}`, `View ${index + 1}`),
        type: typeof view.type === "string" ? view.type : "table",
        order: order.length > 0 ? order : ["file.name"],
        limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
        groupBy:
          group && typeof group.property === "string"
            ? { property: group.property, direction: direction(group.direction) }
            : undefined,
        sort,
        filter: compileFilter(view.filters, viewUnsupported),
        unsupported: [...viewUnsupported],
      };
    });
  if (views.length === 0) {
    views.push({
      name: t("表", "Table"),
      type: "table",
      order: ["file.name"],
      sort: [],
      filter: { kind: "skip" },
      unsupported: [],
    });
  }
  return { filter, displayNames, views, unsupported: [...unsupported] };
}

// --- 表 ---

export type BaseColumn = { property: string; label: string };
export type BaseGroup = { label?: string; rows: BaseRow[] };
export type BaseTable = { columns: BaseColumn[]; groups: BaseGroup[]; total: number };

const FILE_LABELS: Record<string, () => string> = {
  "file.name": () => t("ノート", "Note"),
  "file.basename": () => t("ノート", "Note"),
  "file.path": () => t("場所", "Path"),
  "file.folder": () => t("フォルダ", "Folder"),
  "file.ext": () => t("種類", "Extension"),
  "file.mtime": () => t("更新日時", "Modified"),
  "file.ctime": () => t("作成日時", "Created"),
  "file.size": () => t("サイズ", "Size"),
  "file.tags": () => t("タグ", "Tags"),
  "file.links": () => t("リンク", "Links"),
};

export function columnLabel(base: BaseFile, property: string): string {
  const key = normalizeProperty(property);
  return base.displayNames[key] ?? FILE_LABELS[key]?.() ?? key;
}

function sortValue(row: BaseRow, property: string): unknown {
  // 名前の列は、拡張子なしの名前で並べる
  if (property === "file.name") return baseName(row.name).toLowerCase();
  const value = propertyValue(row, normalizeProperty(property));
  return typeof value === "string" ? value.toLowerCase() : value;
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/** 並べ替えの比較。空の値は、昇順でも降順でも最後に回す */
function compareForSort(a: unknown, b: unknown, dir: "ASC" | "DESC"): number {
  const emptyA = isEmpty(a);
  const emptyB = isEmpty(b);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const order =
    compareValues(Array.isArray(a) ? a.join(",") : a, Array.isArray(b) ? b.join(",") : b) ??
    String(a).localeCompare(String(b));
  return dir === "DESC" ? -order : order;
}

export function buildTable(base: BaseFile, view: BaseView, rows: BaseRow[]): BaseTable {
  const filter: Filter = { kind: "and", items: [base.filter, view.filter] };
  let matched = rows.filter((row) => matches(filter, row) !== false);
  const sorts = view.sort.length > 0 ? view.sort : [{ property: "file.name", direction: "ASC" as const }];
  matched = [...matched].sort((a, b) => {
    for (const { property, direction } of sorts) {
      const order = compareForSort(sortValue(a, property), sortValue(b, property), direction);
      if (order !== 0) return order;
    }
    return a.name.localeCompare(b.name);
  });
  const total = matched.length;
  if (view.limit !== undefined) matched = matched.slice(0, view.limit);
  const columns = view.order.map((property) => ({ property, label: columnLabel(base, property) }));

  if (!view.groupBy) return { columns, groups: [{ rows: matched }], total };
  const { property, direction } = view.groupBy;
  const byKey = new Map<string, { value: unknown; rows: BaseRow[] }>();
  for (const row of matched) {
    const value = propertyValue(row, normalizeProperty(property));
    const key = formatValue(value);
    const entry = byKey.get(key) ?? { value, rows: [] };
    entry.rows.push(row);
    byKey.set(key, entry);
  }
  const groups = [...byKey.entries()]
    .sort(([, a], [, b]) => {
      return compareForSort(
        typeof a.value === "string" ? a.value.toLowerCase() : a.value,
        typeof b.value === "string" ? b.value.toLowerCase() : b.value,
        direction,
      );
    })
    .map(([key, entry]) => ({ label: key === "" ? t("（なし）", "(None)") : key, rows: entry.rows }));
  return { columns, groups, total };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** セルに出す文字。日付は YYYY-MM-DD（時刻があれば HH:MM も）、リストはカンマ区切り、リンクは名前だけ */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const d = toDate(value)!;
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    return midnight ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (Array.isArray(value)) return value.map(formatValue).filter((s) => s !== "").join(", ");
  if (typeof value === "string") {
    return value.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? baseName(target));
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** セルの値。名前の列は拡張子なしの名前にする */
export function cellText(row: BaseRow, property: string): string {
  if (property === "file.name" || property === "file.basename") return baseName(row.name);
  if (property.startsWith("formula.")) return "";
  if (property === "file.links") return (row.links ?? []).map(baseName).join(", ");
  return formatValue(propertyValue(row, normalizeProperty(property)));
}
