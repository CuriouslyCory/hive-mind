/**
 * Spellings of an auth route path (relative to the auth base path, such as
 * `/device/approve`) that a router could read as that route: trailing,
 * doubled and leading slashes, encoded and double-encoded slashes, a
 * backslash, an encoded first letter, other case, and dot segments. Tests of
 * routes closed over HTTP run every one, so a router upgrade that normalizes
 * paths differently cannot reopen a route without a test failing.
 */
export function authPathVariants(path: string): string[] {
  const [first = "", ...rest] = path.split("/").filter(Boolean);
  const tail = rest.join("/");
  const encodedFirstLetter = `%${first.charCodeAt(0).toString(16)}${first.slice(1)}`;
  return [
    path,
    `${path}/`,
    `${path}//`,
    `/${path}`,
    `/${first}//${tail}`,
    `/${first}%2F${tail}`,
    `/${first}%2f${tail}`,
    `/${first}%252F${tail}`,
    `/${first}%5C${tail}`,
    `/${encodedFirstLetter}/${tail}`,
    path.toUpperCase(),
    path.replace(
      /(^|[/-])([a-z])/g,
      (_, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`,
    ),
    `/${first}/./${tail}`,
    `/${first}/x/../${tail}`,
    `/${first}/x/..%2F${tail}`,
    `/x/..%2F${first}/${tail}`,
  ];
}
