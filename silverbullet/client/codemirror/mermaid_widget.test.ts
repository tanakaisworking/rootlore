import { afterEach, expect, test, vi } from "vitest";

const { renderMermaid } = vi.hoisted(() => ({ renderMermaid: vi.fn() }));
vi.mock("../vault_web_mermaid.ts", () => ({ renderMermaid }));

import { MermaidWidget } from "./mermaid_widget.ts";

type FakeElement = {
  className: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  children: FakeElement[];
  classList: { add: (name: string) => void };
  append: (...children: FakeElement[]) => void;
  querySelector: (selector: string) => FakeElement | null;
  removeAttribute: (name: string) => void;
};

function element(): FakeElement {
  const el: FakeElement = {
    className: "",
    dataset: {},
    style: {},
    textContent: "",
    innerHTML: "",
    children: [],
    classList: { add: vi.fn() },
    append: (...children) => {
      el.children.push(...children);
    },
    querySelector: (selector) =>
      selector === "svg" && el.innerHTML.includes("<svg")
        ? ({ removeAttribute: vi.fn(), style: {} } as unknown as FakeElement)
        : null,
    removeAttribute: vi.fn(),
  };
  return el;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test("a rendered diagram replaces the source and asks CodeMirror to measure it", async () => {
  const svg = { removeAttribute: vi.fn(), style: {} as Record<string, string> };
  vi.stubGlobal("document", {
    createElement: () => ({ ...element(), querySelector: () => svg }),
  });
  renderMermaid.mockResolvedValue('<svg height="200"><text>図</text></svg>');
  const onRendered = vi.fn();
  const widget = new MermaidWidget("flowchart LR\nA --> B", false, onRendered);
  const dom = widget.toDOM() as unknown as FakeElement;

  await vi.waitFor(() => expect(dom.dataset.mermaidState).toBe("rendered"));
  expect(dom.innerHTML).toContain("<svg");
  expect(svg.removeAttribute).toHaveBeenCalledWith("height");
  expect(svg.style.maxWidth).toBe("100%");
  expect(svg.style.height).toBe("auto");
  expect(onRendered).toHaveBeenCalledOnce();
});

test("a broken diagram falls back to its fenced source without throwing", async () => {
  vi.stubGlobal("document", { createElement: () => element() });
  renderMermaid.mockRejectedValue(new Error("invalid diagram"));
  const onRendered = vi.fn();
  const source = "flowchart LR\nA -->";
  const dom = new MermaidWidget(
    source,
    true,
    onRendered,
  ).toDOM() as unknown as FakeElement;

  await vi.waitFor(() => expect(dom.dataset.mermaidState).toBe("error"));
  expect(dom.classList.add).toHaveBeenCalledWith("sb-mermaid-error");
  expect(dom.children[0].textContent).toBe(
    "図を表示できませんでした。元のコードを表示しています。",
  );
  expect(dom.children[1].textContent).toBe(`\`\`\`mermaid\n${source}\n\`\`\``);
  expect(onRendered).toHaveBeenCalledOnce();
});
