/** Joins the truthy class names, as the design system bundle's `cx` does. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
