/**
 * The space's `view.defaults` table: per-view presentation defaults, sitting
 * between a client's own datastore override and the view's declared value.
 * Everything here is pure — resolution against a particular view's
 * `supportedDocks` happens in `dock_state.ts`, which is the only place that
 * knows what a given view supports.
 */

import { ALL_DOCKS } from "./types.ts";

const MIN_DOCK_SIZE = 160;
const MAX_DOCK_SIZE = 600;

export type ViewDefaults = {
  dock?: string;
  open?: boolean;
  collapsed?: boolean;
  width?: number;
  height?: number;
};

export type ViewDefaultsTable = Record<string, ViewDefaults>;

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeViewDefaults(raw: unknown): ViewDefaultsTable {
  if (!isTable(raw)) return {};
  const out: ViewDefaultsTable = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isTable(value)) {
      console.warn(`view.defaults: ignoring "${name}", expected a table`);
      continue;
    }
    const entry: ViewDefaults = {};
    const { dock, open, collapsed, width, height } = value;
    if (dock !== undefined) {
      if (
        typeof dock === "string" &&
        (ALL_DOCKS as readonly string[]).includes(dock)
      ) {
        entry.dock = dock;
      } else {
        console.warn(`view.defaults: ignoring dock for "${name}": ${dock}`);
      }
    }
    if (open !== undefined) {
      if (typeof open === "boolean") entry.open = open;
      else console.warn(`view.defaults: ignoring open for "${name}"`);
    }
    if (collapsed !== undefined) {
      if (typeof collapsed === "boolean") entry.collapsed = collapsed;
      else console.warn(`view.defaults: ignoring collapsed for "${name}"`);
    }
    if (width !== undefined) {
      if (typeof width === "number" && Number.isFinite(width)) {
        entry.width = Math.min(MAX_DOCK_SIZE, Math.max(MIN_DOCK_SIZE, width));
      } else {
        console.warn(`view.defaults: ignoring width for "${name}"`);
      }
    }
    if (height !== undefined) {
      if (typeof height === "number" && Number.isFinite(height)) {
        entry.height = Math.min(MAX_DOCK_SIZE, Math.max(MIN_DOCK_SIZE, height));
      } else {
        console.warn(`view.defaults: ignoring height for "${name}"`);
      }
    }
    if (Object.keys(entry).length > 0) out[name] = entry;
  }
  return out;
}

/** Folds the pre-`view.defaults` dock tables in underneath, in the order given. */
export function mergeLegacyDocks(
  defaults: ViewDefaultsTable,
  ...legacy: unknown[]
): ViewDefaultsTable {
  const out: ViewDefaultsTable = { ...defaults };
  for (const table of legacy) {
    if (!isTable(table)) continue;
    for (const [name, dock] of Object.entries(table)) {
      if (typeof dock !== "string") continue;
      if (out[name]?.dock !== undefined) continue;
      out[name] = { ...out[name], dock };
    }
  }
  return out;
}

/**
 * vault-web: この製品の既定。ノート一覧は最初から開いておく。
 * vault の `view.defaults` が同じ項目を持てば、そちらが優先される（下に敷く）。
 * 閉じた人の保存値は `dock_state.ts` が先に見るので、次からも閉じたままになる。
 */
const VAULT_WEB_DEFAULTS: ViewDefaultsTable = {
  "std.spaceTree": { open: true },
};

export function withVaultWebDefaults(
  defaults: ViewDefaultsTable,
): ViewDefaultsTable {
  const out: ViewDefaultsTable = { ...defaults };
  for (const [name, value] of Object.entries(VAULT_WEB_DEFAULTS)) {
    out[name] = { ...value, ...out[name] };
  }
  return out;
}
