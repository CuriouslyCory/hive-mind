"use client";

import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { cx } from "./cx";

export type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "type" | "role" | "children" | "defaultChecked"
> & {
  /** Controlled state. Leave undefined to let the switch keep its own. */
  checked?: boolean;
  /** Initial state when uncontrolled. */
  defaultChecked?: boolean;
  /** Called with the new state on every toggle. */
  onChange?: (checked: boolean) => void;
  /** Visible label inside the control. Without it, pass `aria-label`. */
  label?: ReactNode;
};

/** An on/off setting, as `role="switch"` on a button. */
export function Switch({
  checked,
  defaultChecked = false,
  onChange,
  label,
  disabled,
  className,
  onClick,
  ...rest
}: SwitchProps) {
  const [ownChecked, setOwnChecked] = useState(defaultChecked);
  const controlled = typeof checked === "boolean";
  const on = controlled ? checked : ownChecked;
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={cx("hm-switch", className)}
      onClick={(event) => {
        onClick?.(event);
        if (disabled || event.defaultPrevented) return;
        if (!controlled) setOwnChecked(!on);
        onChange?.(!on);
      }}
    >
      <span className="hm-switch-track">
        <span className="hm-switch-thumb" />
      </span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}
