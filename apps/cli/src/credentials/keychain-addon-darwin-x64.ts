// Embeds the darwin-x64 Keychain addon as a plain file: the default export is
// its path inside the compiled binary. Only reached from keychain-binding.ts
// when HIVEMIND_BUILD_TARGET is bun-darwin-x64.
import addonPath from "@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node" with { type: "file" };

export default addonPath;
