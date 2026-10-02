import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

// The dashboard's one markdown renderer (issue #11, "Shared content"), used
// for Plan bodies, Plan log entries and Session end summaries. These are
// written by agents and Users, so they are untrusted:
//
// - Raw HTML is dropped (`skipHtml`), never parsed or rendered.
// - The HTML tree is sanitized with rehype-sanitize (GitHub's schema, minus
//   images) after every other step, so no plugin can reintroduce a script,
//   event handler or style.
// - Links keep only http, https and mailto URLs; anything else (javascript:,
//   data:, vbscript:, relative paths) renders as plain text. Every link gets
//   rel="noopener noreferrer nofollow".
// - Images are never loaded (a remote image reports the viewer to its host);
//   one renders as its alt text.
// - Headings are shifted down so a document's `#` never competes with the
//   page's own headings.
//
// It renders synchronously, so it works in Server Components. Labels, intent
// and Event text are not markdown: render them as plain React text.

/** URL schemes a rendered link may use. */
export const ALLOWED_LINK_PROTOCOLS = ["http:", "https:", "mailto:"] as const;

/** The URL if it is absolute with an allowed scheme, else "" (no link). */
export function safeLinkUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }
  return (ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(url.protocol) ? url.href : "";
}

const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((name) => name !== "img"),
  protocols: { href: ALLOWED_LINK_PROTOCOLS.map((protocol) => protocol.slice(0, -1)) },
};

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

/** Replaces every image with a text node of its alt text, before sanitizing. */
function imagesAsText() {
  const visit = (node: HastNode) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type === "element" && child.tagName === "img") {
        const alt = child.properties?.alt;
        return {
          type: "text",
          value: typeof alt === "string" && alt.length > 0 ? `[image: ${alt}]` : "[image]",
        };
      }
      visit(child);
      return child;
    });
  };
  return (tree: HastNode) => visit(tree);
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function headingComponents(offset: number): Components {
  const components: Components = {};
  HEADING_TAGS.forEach((tag, index) => {
    const level = Math.min(index + 1 + offset, 6) as HeadingLevel;
    const Tag = HEADING_TAGS[level - 1] ?? "h6";
    components[tag] = ({ children }) => <Tag>{children}</Tag>;
  });
  return components;
}

const baseComponents: Components = {
  // Only href and children are passed on: no attribute from the document
  // reaches the element except the sanitized, scheme-checked URL.
  a: ({ href, children }) =>
    href ? (
      <a href={href} rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export interface SafeMarkdownProps {
  /** Untrusted markdown. */
  source: string;
  /** Levels to shift headings down by: with 2, `#` renders as `<h3>`. */
  headingOffset?: number;
}

/** Renders untrusted markdown as inert, sanitized HTML. */
export function SafeMarkdown({ source, headingOffset = 2 }: SafeMarkdownProps): ReactNode {
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[imagesAsText, [rehypeSanitize, schema]]}
        urlTransform={safeLinkUrl}
        components={{ ...headingComponents(headingOffset), ...baseComponents }}
      >
        {source}
      </Markdown>
    </div>
  );
}
