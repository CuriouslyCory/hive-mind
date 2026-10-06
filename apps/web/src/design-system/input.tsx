import { type InputHTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "./cx";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  /** The visible label, tied to the input with `htmlFor`. */
  label?: ReactNode;
  /** Help text under the input, tied with `aria-describedby`. When `invalid`, it is the error message. */
  help?: ReactNode;
  /** Marks the field invalid: red edge and tint, `aria-invalid`, and `help` set in the danger colour. */
  invalid?: boolean;
  /** Sets the value in JetBrains Mono, for IDs, keys and commands. */
  mono?: boolean;
  /** Applied to the wrapping field, not the input. */
  className?: string;
};

/** A labelled text field. Usable from a server component: it needs no state. */
export function Input({
  label,
  help,
  invalid,
  mono,
  className,
  id,
  type,
  "aria-describedby": describedBy,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const helpId = `${inputId}-help`;
  const hasHelp = help !== undefined && help !== null && help !== false;
  return (
    <div className={cx("hm-field", invalid && "hm-field-invalid", className)}>
      {label ? (
        <label className="hm-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        {...rest}
        id={inputId}
        type={type ?? "text"}
        className={cx("hm-input", mono && "hm-input-mono")}
        aria-invalid={invalid || undefined}
        aria-describedby={cx(describedBy, hasHelp && helpId) || undefined}
      />
      {hasHelp ? (
        <div className="hm-help" id={helpId}>
          {help}
        </div>
      ) : null}
    </div>
  );
}
