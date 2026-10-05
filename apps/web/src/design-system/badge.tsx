import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "honey" | "success" | "danger" | "info";

export type BadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** Defaults to `neutral`. */
  tone?: BadgeTone;
  /** Fully rounded ends instead of `radius-sm`. */
  pill?: boolean;
  /** Pulses the dot with the honey glow: a working agent. Stops under reduced motion. */
  buzzing?: boolean;
  /** The status word, one or two words. The dot only repeats it, so always pass one. */
  children?: ReactNode;
};

/** A status word with a coloured dot. */
export function Badge({
  tone = "neutral",
  pill,
  buzzing,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "hm-badge",
        `hm-badge-${tone}`,
        pill && "hm-badge-pill",
        buzzing && "hm-badge-buzzing",
        className,
      )}
    >
      {children}
    </span>
  );
}
