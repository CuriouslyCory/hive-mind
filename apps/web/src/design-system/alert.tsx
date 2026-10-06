import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icon";

export type AlertTone = "info" | "warning" | "success" | "danger";

const toneIcons: Record<AlertTone, IconName> = {
  info: "info",
  warning: "alert",
  success: "check",
  danger: "alert",
};

export type AlertProps = Omit<HTMLAttributes<HTMLDivElement>, "title" | "role"> & {
  /** Defaults to `info`. `danger` is announced at once (`role="alert"`); the rest politely (`role="status"`). */
  tone?: AlertTone;
  /**
   * Whether the Alert is a live region. Defaults to true. Pass false for a
   * notice that is part of the page and should not be announced: it then
   * renders `role="note"`.
   */
  live?: boolean;
  title?: ReactNode;
  /** What happened and the next step. A string becomes a paragraph. */
  children?: ReactNode;
  /** A control on the right, such as a Button. */
  action?: ReactNode;
};

function AlertBody({ children }: { children: ReactNode }) {
  if (children === undefined || children === null || children === false) return null;
  if (typeof children === "string" || typeof children === "number") {
    return <p className="hm-alert-body">{children}</p>;
  }
  return <div className="hm-alert-body">{children}</div>;
}

/** An inline message. Each tone travels with its glyph, never colour alone. */
export function Alert({
  tone = "info",
  live = true,
  title,
  action,
  className,
  children,
  ...rest
}: AlertProps) {
  return (
    <div
      {...rest}
      role={live ? (tone === "danger" ? "alert" : "status") : "note"}
      className={cx("hm-alert", `hm-alert-${tone}`, className)}
    >
      <Icon name={toneIcons[tone]} />
      <div>
        {title ? <p className="hm-alert-title">{title}</p> : null}
        <AlertBody>{children}</AlertBody>
      </div>
      {action ? <div className="hm-alert-action">{action}</div> : null}
    </div>
  );
}
