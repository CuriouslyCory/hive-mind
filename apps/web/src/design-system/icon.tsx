import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

// The design system's icon set (docs/design-system.md → Rules → Icons; origin
// in ADR-0016): a 24px grid, 2px round strokes and hexagon frames, inlined so
// every glyph takes `currentColor`. `up`, `down` and `flat` are the small
// glyphs for Cell deltas.

const HEX_FRAME = "12.00,2.50 20.23,7.25 20.23,16.75 12.00,21.50 3.77,16.75 3.77,7.25";
const HEX_OUTLINE = "12.00,3.00 19.79,7.50 19.79,16.50 12.00,21.00 4.21,16.50 4.21,7.50";

const glyphs = {
  agent: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 8V4M9 4h6" />
      <circle cx="9.5" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  alert: (
    <>
      <polygon points={HEX_FRAME} />
      <path d="M12 8v5" />
      <circle cx="12" cy="16.3" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  "chevron-down": <path d="M6 9.5l6 6 6-6" />,
  "chevron-right": <path d="M9.5 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  hex: <polygon points={HEX_OUTLINE} />,
  hive: (
    <>
      <polygon points={HEX_OUTLINE} />
      <polygon
        points="12.00,8.50 15.03,10.25 15.03,13.75 12.00,15.50 8.97,13.75 8.97,10.25"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  info: (
    <>
      <polygon points={HEX_FRAME} />
      <path d="M12 11v5" />
      <circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  node: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 9V3M14.6 13.5l5.2 3M9.4 13.5l-5.2 3" />
      <circle cx="12" cy="3" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="19.8" cy="16.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4.2" cy="16.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" />
    </>
  ),
  settings: (
    <>
      <polygon points={HEX_OUTLINE} />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path
        d="M19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7z"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  flat: <path d="M5 12h14" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs;

/** Every icon name: the 16 glyphs of the icon set, then the Cell delta glyphs. */
export const iconNames = Object.keys(glyphs) as IconName[];

export type IconProps = {
  name: IconName;
  /** Rendered size in px. Controls (Button, Alert, Cell delta) size their icons in CSS. */
  size?: number;
  /** Accessible name. Without it the icon is decorative and hidden from assistive technology. */
  title?: string;
  className?: string;
  style?: CSSProperties;
};

const svgAttributes = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function Icon({ name, size = 24, title, className, style }: IconProps) {
  if (title) {
    return (
      <svg
        {...svgAttributes}
        width={size}
        height={size}
        className={className}
        style={style}
        role="img"
        aria-label={title}
      >
        <title>{title}</title>
        {glyphs[name]}
      </svg>
    );
  }
  return (
    <svg
      {...svgAttributes}
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      {glyphs[name]}
    </svg>
  );
}

/** The hexagon clip path of `hm-hex` and `hm-cell-hex`, for elements styled outside components.css. */
export const HEXAGON_CLIP_PATH = "polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%)";

/**
 * The six corners of a pointy-top hexagon centred on (cx, cy), as an SVG
 * `points` string. HEX_OUTLINE (the `hex`, `hive` and `settings` icons) is
 * hexagonPoints(12, 12, 9); HEX_FRAME (`info`, `alert`) is
 * hexagonPoints(12, 12, 9.5); the filled centre of `hive` is
 * hexagonPoints(12, 12, 3.5).
 */
export function hexagonPoints(cx: number, cy: number, radius: number): string {
  return [-90, -30, 30, 90, 150, 210]
    .map((degrees) => {
      const radians = (degrees * Math.PI) / 180;
      const x = cx + radius * Math.cos(radians);
      const y = cy + radius * Math.sin(radians);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export type HexagonTone = "tint" | "honey" | "hive";

export type HexagonProps = {
  /** Width and height in px. */
  size?: number;
  /** `tint` (hive-tint ground), `honey` (the honey gradient) or `hive` (the navy panel). */
  tone?: HexagonTone;
  className?: string;
  style?: CSSProperties;
  /** Content centred in the hexagon, such as a step number. Without it the shape is decorative. */
  children?: ReactNode;
};

/** The signature hexagon shape, used sparingly: one or two per view. */
export function Hexagon({ size = 44, tone = "tint", className, style, children }: HexagonProps) {
  return (
    <span
      className={cx("hm-hex", tone !== "tint" && `hm-hex-${tone}`, className)}
      style={{ width: size, height: size, ...style }}
      aria-hidden={children === undefined || children === null ? "true" : undefined}
    >
      {children}
    </span>
  );
}
