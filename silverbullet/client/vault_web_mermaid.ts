// Rootlore: render ```mermaid blocks as diagrams (see docs/fork-changes.md).
//
// SilverBullet 2.12 has no Mermaid renderer. The upstream library
// (Library/silverbullet-diagram) runs Space Lua in the note and imports Mermaid
// from esm.sh; Rootlore does neither (CSP `script-src 'self'`, and note Lua is
// not trusted), so the renderer lives in the client bundle and Mermaid is a lazy
// chunk served from our own origin. Pages without diagrams do not execute it;
// the Service Worker still precaches the client chunks so diagrams work offline.

import { reportException } from "./vault_web_error_reports.ts";

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

let loading: Promise<MermaidApi> | undefined;
let initializedTheme: string | undefined;
let counter = 0;

export function isMermaidLanguage(language: string | undefined): boolean {
  return language === "mermaid";
}

/** Diagram theme for the page's current appearance. */
export function mermaidTheme(dark: boolean): "dark" | "default" {
  return dark ? "dark" : "default";
}

/**
 * Shapes Mermaid must never produce, even in strict mode. Mermaid sanitizes its
 * own labels; this is the second check before the SVG goes into the page.
 */
export function looksUnsafeSvg(svg: string): boolean {
  return (
    /<script[\s>]/i.test(svg) ||
    /<foreignobject[\s>]/i.test(svg) ||
    /<iframe[\s>]/i.test(svg) ||
    /<[^>]*\son[a-z]+\s*=/i.test(svg) ||
    /(?:href|src)\s*=\s*["']?\s*(?:javascript|data|vbscript):/i.test(svg)
  );
}

async function loadMermaid(theme: string): Promise<MermaidApi> {
  loading ??= import("mermaid")
    .then(
      (mod) => ((mod as { default?: MermaidApi }).default ?? mod) as MermaidApi,
    )
    .catch((error: unknown) => {
      loading = undefined;
      reportException(error);
      throw error;
    });
  const mermaid = await loading;
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // Note content is untrusted: strict disables click handlers and sanitizes
      // HTML in labels. htmlLabels off keeps the SVG free of foreignObject.
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      theme,
      fontFamily: FONT,
    });
    initializedTheme = theme;
  }
  return mermaid;
}

/**
 * Drops every link target. Note content is untrusted, so a diagram must not
 * navigate anywhere (Mermaid keeps `click X href ...` links even in strict mode).
 */
export function withoutLinks(svg: string): string {
  return svg.replace(/<a\b[^>]*>/gi, (tag) =>
    tag.replace(/\s(?:xlink:)?href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""),
  );
}

/**
 * Mermaid shrinks a diagram to the column width (`width="100%"`), which makes
 * a wide flowchart unreadable. Give the root its own size from the viewBox
 * instead; the wrapper scrolls sideways when it is wider than the page.
 */
export function atNaturalSize(svg: string): string {
  return svg.replace(/^<svg\b[^>]*>/, (tag) => {
    const box = tag.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/);
    if (!box) return tag;
    const width = Math.ceil(Number(box[1]));
    const height = Math.ceil(Number(box[2]));
    return tag
      .replace(/\s(?:width|height|style)="[^"]*"/g, "")
      .replace(/^<svg/, `<svg width="${width}" height="${height}"`);
  });
}

/** Render one diagram to SVG. Throws an Error with a short message. */
export async function renderMermaid(
  source: string,
  dark: boolean,
): Promise<string> {
  if (!source.trim()) throw new Error("empty diagram");
  const mermaid = await loadMermaid(mermaidTheme(dark));
  const id = `rootlore-mermaid-${(counter = (counter + 1) % 100000)}`;
  const { svg } = await mermaid.render(id, source);
  if (looksUnsafeSvg(svg))
    throw new Error("the diagram produced markup that is not allowed");
  return atNaturalSize(withoutLinks(svg));
}
