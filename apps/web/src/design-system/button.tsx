import type { Route } from "next";
import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icon";

export type ButtonVariant = "primary" | "honey" | "outline" | "quiet" | "danger";
export type ButtonSize = "sm" | "lg";

type ButtonOwnProps = {
  /** Defaults to `outline`, as in the bundle. */
  variant?: ButtonVariant;
  /** Omit for the default 36px control. */
  size?: ButtonSize;
  /** A glyph from the Icons group, drawn before the label at 20px. */
  icon?: IconName;
  className?: string;
  children?: ReactNode;
};

export type ButtonAsButtonProps = ButtonOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps> & {
    href?: undefined;
  };

export type ButtonAsLinkProps<T extends string = string> = ButtonOwnProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonOwnProps | "href"> & {
    /** An app route renders a Next `Link`; anything else (`https:`, `#id`) a plain `<a>`. */
    href: Route<T>;
  };

export type ButtonProps<T extends string = string> = ButtonAsButtonProps | ButtonAsLinkProps<T>;

export function buttonClassName({
  variant = "outline",
  size,
  className,
}: Pick<ButtonOwnProps, "variant" | "size" | "className">): string {
  return cx("hm-btn", `hm-btn-${variant}`, size && `hm-btn-${size}`, className);
}

function isLinkProps<T extends string>(props: ButtonProps<T>): props is ButtonAsLinkProps<T> {
  return props.href !== undefined;
}

function isAppRoute(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

/**
 * Every action. Renders `<button type="button">`, or a link styled the same
 * way when given `href`.
 */
export function Button(props: ButtonAsButtonProps): ReactElement;
export function Button<T extends string>(props: ButtonAsLinkProps<T>): ReactElement;
export function Button<T extends string>(props: ButtonProps<T>): ReactElement {
  if (isLinkProps(props)) {
    const { variant, size, icon, className, children, href, ...anchorProps } = props;
    const classes = buttonClassName({ variant, size, className });
    const content = (
      <>
        {icon ? <Icon name={icon} /> : null}
        {children}
      </>
    );
    if (isAppRoute(href)) {
      return (
        <Link {...anchorProps} href={href} className={classes}>
          {content}
        </Link>
      );
    }
    return (
      <a {...anchorProps} href={href} className={classes}>
        {content}
      </a>
    );
  }
  const { variant, size, icon, className, children, href: _href, type, ...buttonProps } = props;
  return (
    <button
      {...buttonProps}
      type={type ?? "button"}
      className={buttonClassName({ variant, size, className })}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
