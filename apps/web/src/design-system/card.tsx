import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type CardVariant = "default" | "hive";

export type CardProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  /** `hive` is the navy panel with light text. Defaults to `default`. */
  variant?: CardVariant;
  /**
   * Adds the pointer cursor and the floating shadow on hover. It is styling
   * only: the card stays a plain div with no role, tab stop or keys, so its
   * action must be a real link or button inside it.
   */
  interactive?: boolean;
  /** The selected edge and the honey glow. */
  selected?: boolean;
  /** The uppercase label above the title. */
  eyebrow?: ReactNode;
  title?: ReactNode;
  /** Heading level of the title, to fit the page outline. Defaults to 3. */
  headingLevel?: 2 | 3 | 4;
  /** A row of actions under the body. */
  footer?: ReactNode;
  /** A string becomes the muted body paragraph; anything else renders as is. */
  children?: ReactNode;
};

/** The container for one piece of content. */
export function Card({
  variant = "default",
  interactive,
  selected,
  eyebrow,
  title,
  headingLevel = 3,
  footer,
  className,
  children,
  ...rest
}: CardProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      {...rest}
      className={cx(
        "hm-card",
        variant !== "default" && `hm-card-${variant}`,
        interactive && "hm-card-interactive",
        selected && "hm-card-selected",
        className,
      )}
    >
      {eyebrow ? <p className="hm-card-eyebrow">{eyebrow}</p> : null}
      {title ? <Heading className="hm-card-title">{title}</Heading> : null}
      {typeof children === "string" ? (
        <p className="hm-card-body hm-muted">{children}</p>
      ) : (
        children
      )}
      {footer ? <div className="hm-card-footer">{footer}</div> : null}
    </div>
  );
}
