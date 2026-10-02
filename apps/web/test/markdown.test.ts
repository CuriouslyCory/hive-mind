import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/server/dashboard/event-text";
import { SafeMarkdown, safeLinkUrl } from "../src/server/dashboard/markdown";

// The dashboard's markdown renderer with hostile input (issue #11, "Shared
// content"): nothing in the output may run script, load a resource or carry
// an attribute the document chose, while ordinary formatting survives.

function render(source: string, headingOffset?: number): string {
  return renderToStaticMarkup(createElement(SafeMarkdown, { source, headingOffset }));
}

/**
 * Nothing in rendered HTML that could execute or fetch. Text is escaped
 * (`<` becomes `&lt;`), so every `<` starts a real tag; only tags are checked
 * for attributes, since hostile words may stay visible as inert text.
 */
function expectInert(html: string) {
  expect(html).not.toMatch(
    /<(?:script|iframe|object|embed|style|img|svg|math|form|input|link|meta)/i,
  );
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
    expect(tag).not.toMatch(/\s(?:style|src|srcset|action|formaction|xlink:href)\s*=/i);
    expect(tag).not.toMatch(/href\s*=\s*"\s*(?:javascript|data|vbscript|file):/i);
  }
}

describe("SafeMarkdown", () => {
  it("keeps headings, lists, emphasis, code, tables and safe links", () => {
    const html = render(
      [
        "# Title",
        "",
        "Some **bold**, _italic_ and `inline code`.",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "```ts",
        "const x = 1 < 2;",
        "```",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "[docs](https://example.com/docs?a=1&b=2) and <mailto:someone@example.com>",
      ].join("\n"),
    );
    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>inline code</code>");
    expect(html).toMatch(/<ul>\s*<li>one<\/li>/);
    expect(html).toMatch(/<ol>\s*<li>first<\/li>/);
    expect(html).toContain('<code class="language-ts">const x = 1 &lt; 2;\n</code>');
    expect(html).toContain("<table>");
    expect(html).toContain(
      '<a href="https://example.com/docs?a=1&amp;b=2" rel="noopener noreferrer nofollow">docs</a>',
    );
    expect(html).toContain(
      '<a href="mailto:someone@example.com" rel="noopener noreferrer nofollow">',
    );
    expectInert(html);
  });

  it("shifts headings down and caps them at h6", () => {
    expect(render("# A\n\n###### F", 2)).toBe('<div class="markdown"><h3>A</h3>\n<h6>F</h6></div>');
    expect(render("# A", 0)).toContain("<h1>A</h1>");
  });

  it("drops raw HTML, script and event handlers", () => {
    const html = render(
      [
        "<script>alert(1)</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        '<a href="javascript:alert(1)" onclick="alert(1)">click</a>',
        "",
        '<div style="position:fixed" onmouseover="alert(1)">overlay</div>',
        "",
        "<iframe src=https://evil.example></iframe>",
        "",
        "<svg><script>alert(1)</script></svg>",
        "",
        'inline <b onclick="x">bold</b> html',
        "",
        "<style>body{display:none}</style>",
      ].join("\n"),
    );
    expectInert(html);
    // Only the renderer's own wrapper and paragraphs remain.
    expect(html.replace(/^<div class="markdown">/, "")).not.toMatch(/<(?:a|b|div|span)\b/);
    expect(html).toContain("inline");
  });

  it("removes links with unsafe schemes but keeps their text", () => {
    const html = render(
      [
        "[js](javascript:alert(1))",
        "[JS](JaVaScRiPt:alert(1))",
        "[ws](  javascript:alert(1) )",
        "[angle](<javascript:alert(1)>)",
        "[encoded](java%73cript:alert(1))",
        "[entity](&#106;avascript:alert(1))",
        "[hex](&#x6A;avascript:alert(1))",
        "[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
        "[vb](vbscript:msgbox(1))",
        "[file](file:///etc/passwd)",
        "[relative](/api/v1/projects)",
        "[ref][r]",
        "",
        "[r]: javascript:alert(1)",
      ].join("\n\n"),
    );
    expectInert(html);
    expect(html).not.toContain("<a");
    const texts = ["js", "JS", "ws", "angle", "encoded", "entity", "hex", "data", "vb", "file"];
    for (const text of [...texts, "relative", "ref"]) {
      expect(html).toContain(`<span>${text}</span>`);
    }
  });

  it("never loads images, tracking pixels included, and shows their alt text", () => {
    const html = render(
      [
        "![build status](https://tracker.example/pixel.gif?user=1)",
        "",
        "![](https://tracker.example/blank.gif)",
        "",
        '[![nested](https://tracker.example/x.png "t")](https://example.com)',
        "",
        "![ref image][img]",
        "",
        "[img]: https://tracker.example/ref.png",
      ].join("\n"),
    );
    expectInert(html);
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("[image: build status]");
    expect(html).toContain("[image]");
    expect(html).toContain(
      '<a href="https://example.com/" rel="noopener noreferrer nofollow">[image: nested]</a>',
    );
  });

  it("keeps entities as text instead of decoding them into markup", () => {
    const html = render(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;img src=x onerror=alert(1)&amp;gt; &#60;b&#62;",
    );
    expectInert(html);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;lt;img");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("does not let documents choose ids, classes or attributes", () => {
    const html = render(
      ['<span id="login" class="status">x</span>', "", "[a](https://example.com 'title')"].join(
        "\n",
      ),
    );
    expectInert(html);
    expect(html).not.toContain('id="login"');
    expect(html).not.toContain("title=");
    expect(html).not.toContain('class="status"');
  });

  it("renders autolinked URLs only with allowed schemes", () => {
    const html = render("see https://example.com and www.example.org and javascript:alert(1)");
    expect(html).toContain('<a href="https://example.com/" rel="noopener noreferrer nofollow">');
    expect(html).toContain('<a href="http://www.example.org/" rel="noopener noreferrer nofollow">');
    expect(html).not.toMatch(/href="javascript/i);
  });
});

describe("safeLinkUrl", () => {
  it("allows only absolute http, https and mailto URLs", () => {
    expect(safeLinkUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeLinkUrl("http://example.com")).toBe("http://example.com/");
    expect(safeLinkUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
    for (const unsafe of [
      "javascript:alert(1)",
      " javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
      "/relative",
      "//evil.example/x",
      "#fragment",
      "",
    ]) {
      expect(safeLinkUrl(unsafe)).toBe("");
    }
  });
});

describe("describeEvent", () => {
  it("reads only the catalog's typed fields and renders as escaped text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const described = describeEvent("task.added", {
      title: hostile,
      position: 3,
      __proto__: { polluted: true },
      onClick: "alert(1)",
      dangerouslySetInnerHTML: { __html: "<script>x</script>" },
    });
    expect(described).toEqual({ text: `Added Task 3 "${hostile}"`, markdown: null });
    const html = renderToStaticMarkup(createElement("p", null, described.text));
    expect(html).toBe(
      "<p>Added Task 3 &quot;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&quot;</p>",
    );
  });

  it("leaves out mistyped fields and names unknown types only", () => {
    expect(describeEvent("task.added", { title: { toString: "x" }, position: "3" }).text).toBe(
      "Added Task",
    );
    expect(describeEvent("future.thing", { secret: "do not show" })).toEqual({
      text: "Event future.thing",
      markdown: null,
    });
    expect(describeEvent("scope.touched", null).text).toBe("Touched paths");
  });

  it("hands Plan log entries to the markdown renderer", () => {
    const described = describeEvent("plan.log_appended", { message: "[x](javascript:alert(1))" });
    expect(described.markdown).toBe("[x](javascript:alert(1))");
    expectInert(render(described.markdown ?? ""));
  });
});
