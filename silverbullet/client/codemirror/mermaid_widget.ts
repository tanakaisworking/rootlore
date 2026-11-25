import type { Range } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import type { Client } from "../client.ts";
import { t } from "../vault_web_i18n.ts";
import { isMermaidLanguage, renderMermaid } from "../vault_web_mermaid.ts";
import { LoadingWidget } from "./loading_widget.ts";
import { invisibleDecoration, type WidgetRenderMode } from "./util.ts";

/** The page's current light/dark choice, the same rule the editor theme uses. */
function editorIsDark(client: Client): boolean {
  return (
    client.ui.viewState.uiOptions.darkMode ??
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ??
    false
  );
}

/**
 * Decorations for one ```mermaid fence (called from fenced_code.ts), or
 * undefined when the fence is not Mermaid or widgets are off. Same shape as the
 * upstream code widgets: the fence lines are hidden and the diagram sits where
 * the opening fence was.
 */
export function mermaidDecorations(
  client: Client,
  from: number,
  text: string,
  lang: string | undefined,
  renderMode: WidgetRenderMode,
): Range<Decoration>[] | undefined {
  if (!isMermaidLanguage(lang) || renderMode === "disabled") return undefined;
  const lines = text.split("\n");
  if (lines.length < 2) return undefined;
  const openingFence = lines[0].match(/^(`{3,}|~{3,})/)?.[1];
  const closingFence = lines[lines.length - 1].match(
    /^\s*(`{3,}|~{3,})\s*$/,
  )?.[1];
  if (
    !openingFence ||
    !closingFence ||
    closingFence[0] !== openingFence[0] ||
    closingFence.length < openingFence.length
  ) {
    return undefined;
  }
  const starts: number[] = [];
  let at = from;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const last = lines.length - 1;
  const widget =
    renderMode === "loading"
      ? new LoadingWidget(true)
      : new MermaidWidget(
          lines.slice(1, last).join("\n"),
          editorIsDark(client),
          () => client.editorView?.requestMeasure(),
        );
  const decorations: Range<Decoration>[] = [
    invisibleDecoration.range(starts[0], starts[0] + lines[0].length),
    invisibleDecoration.range(starts[last], starts[last] + lines[last].length),
    Decoration.line({ class: "sb-fenced-code-iframe" }).range(starts[0]),
    Decoration.line({ class: "sb-fenced-code-hide" }).range(starts[last]),
    Decoration.widget({ widget, block: true }).range(from),
  ];
  for (let i = 1; i < last; i++) {
    decorations.push(
      Decoration.line({ class: "sb-line-table-outside" }).range(starts[i]),
    );
  }
  return decorations;
}

/**
 * A fenced ```mermaid block rendered as a diagram. The source stays in the
 * note; moving the cursor into the block shows it again (fenced_code.ts hides
 * the widget while the cursor is inside).
 */
export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly dark: boolean,
    readonly onRendered?: () => void,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidWidget &&
      other.source === this.source &&
      other.dark === this.dark
    );
  }

  override get estimatedHeight(): number {
    return 220;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "sb-mermaid";
    wrapper.dataset.mermaidState = "loading";
    renderMermaid(this.source, this.dark)
      .then((svg) => {
        // Strict mode + looksUnsafeSvg; the same shapes the app forbids elsewhere.
        wrapper.innerHTML = svg;
        wrapper.dataset.mermaidState = "rendered";
      })
      .catch(() => {
        wrapper.classList.add("sb-mermaid-error");
        wrapper.dataset.mermaidState = "error";
        const message = document.createElement("p");
        message.className = "sb-mermaid-error-message";
        message.textContent = t(
          "図を表示できませんでした。元のコードを表示しています。",
          "Couldn't render the diagram. Showing the original code.",
        );
        const source = document.createElement("pre");
        source.textContent = `\`\`\`mermaid\n${this.source}\n\`\`\``;
        wrapper.append(message, source);
      })
      .finally(() => {
        try {
          this.onRendered?.();
        } catch {
          // The editor may already be gone; rendering must not affect the note.
        }
      });
    return wrapper;
  }
}
