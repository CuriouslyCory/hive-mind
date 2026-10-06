import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";

export type CellTone = "neutral" | "honey" | "success" | "danger";

export type CellProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** The uppercase caption. */
  label: ReactNode;
  /** The number. Set in Sora with tabular figures. */
  value: ReactNode;
  /** Colours the hexagon in the corner. Defaults to `neutral`. */
  tone?: CellTone;
  /** Change since the last period. Positive is drawn up and green, negative down and red, 0 flat. */
  delta?: number;
  /** Appended to the delta. Defaults to `%`. */
  deltaUnit?: string;
  /** Muted text after the delta, such as "vs last week". */
  deltaLabel?: ReactNode;
  /** The selected edge and the honey glow. */
  selected?: boolean;
};

function deltaDirection(delta: number): "up" | "down" | "flat" {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

/** The hexagon stat tile, for a number that deserves a place of honour. */
export function Cell({
  label,
  value,
  tone = "neutral",
  delta,
  deltaUnit = "%",
  deltaLabel,
  selected,
  className,
  ...rest
}: CellProps) {
  const direction = delta === undefined ? null : deltaDirection(delta);
  return (
    <div
      {...rest}
      className={cx("hm-cell", `hm-cell-${tone}`, selected && "hm-cell-selected", className)}
    >
      <span className="hm-cell-hex" aria-hidden="true" />
      <p className="hm-cell-label">{label}</p>
      <p className="hm-cell-value">{value}</p>
      {direction && delta !== undefined ? (
        <p className={`hm-cell-delta hm-cell-delta-${direction}`}>
          <Icon name={direction} />
          {`${delta > 0 ? "+" : ""}${delta}${deltaUnit}`}
          {deltaLabel ? <span className="hm-cell-delta-label">{deltaLabel}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
