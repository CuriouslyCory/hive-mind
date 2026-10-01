// Embeds the darwin-arm64 Keychain addon as a plain file: the default export is
// its path inside the compiled binary. Only reached from keychain-binding.ts
// when HIVEMIND_BUILD_TARGET is bun-darwin-arm64.
import addonPath from "@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node" with {
  type: "file",
};

export default addonPath;
