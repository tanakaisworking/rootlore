import { expect, test } from "vitest";
import {
  isMermaidLanguage,
  looksUnsafeSvg,
  mermaidTheme,
  withoutLinks,
} from "./vault_web_mermaid.ts";

test("only the mermaid fence is handled here", () => {
  expect(isMermaidLanguage("mermaid")).toBe(true);
  expect(isMermaidLanguage("Mermaid")).toBe(false);
  expect(isMermaidLanguage("mmd")).toBe(false);
  expect(isMermaidLanguage(undefined)).toBe(false);
});

test("the diagram follows the page's appearance", () => {
  expect(mermaidTheme(true)).toBe("dark");
  expect(mermaidTheme(false)).toBe("default");
});

test("markup that could run or fetch is refused", () => {
  expect(looksUnsafeSvg("<svg><script>alert(1)</script></svg>")).toBe(true);
  expect(
    looksUnsafeSvg("<svg><foreignObject><div>hi</div></foreignObject></svg>"),
  ).toBe(true);
  expect(looksUnsafeSvg("<svg><iframe src='/x'></iframe></svg>")).toBe(true);
  expect(looksUnsafeSvg("<svg><rect onload='x()'></rect></svg>")).toBe(true);
  expect(looksUnsafeSvg("<svg><a href='javascript:alert(1)'></a></svg>")).toBe(
    true,
  );
  expect(
    looksUnsafeSvg('<svg><a xlink:href="data:text/html,x"></a></svg>'),
  ).toBe(true);
  // What Mermaid produces in strict mode for a plain flow chart
  expect(
    looksUnsafeSvg(
      '<svg id="m" viewBox="0 0 10 10"><style>#m .node rect{fill:#eee}</style><g class="node"><rect width="10" height="10"/><text>事業</text></g></svg>',
    ),
  ).toBe(false);
  // A link to a page is fine
  expect(
    looksUnsafeSvg(
      '<svg><a href="https://example.com/x"><text>x</text></a></svg>',
    ),
  ).toBe(false);
});

test("links in a diagram lead nowhere", () => {
  expect(
    withoutLinks(
      '<svg><a href="https://example.com/x" xlink:href=\'/v/page\'><text>x</text></a></svg>',
    ),
  ).toBe("<svg><a><text>x</text></a></svg>");
  expect(withoutLinks("<svg><a href=/x><text>x</text></a></svg>")).toBe(
    "<svg><a><text>x</text></a></svg>",
  );
});
