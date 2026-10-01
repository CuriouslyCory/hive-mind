// `import x from "<file>.node" with { type: "file" }` gives the file's path
// inside the compiled binary (see keychain-addon-darwin-*.ts).
declare module "*.node" {
  const path: string;
  export default path;
}
