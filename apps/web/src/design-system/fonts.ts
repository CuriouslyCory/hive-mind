import localFont from "next/font/local";

// The three faces (docs/design-system.md → Fonts), vendored in ./fonts as the
// latin subset of Google Fonts' variable files, each with its OFL licence.
// They are local rather than next/font/google because Google answers
// next/font's build-time request with a Nunito Sans file that renders a gap
// after "t" (ADR-0016). Each declares a CSS variable on the element that
// carries its class; tokens.css reads those variables inside `.hm-fonts` to
// build --font-display, --font-sans and --font-mono.
const sora = localFont({
  src: "./fonts/sora-latin.woff2",
  weight: "600 800",
  display: "swap",
  variable: "--hm-font-sora",
});

const nunitoSans = localFont({
  src: "./fonts/nunito-sans-latin.woff2",
  weight: "400 700",
  display: "swap",
  variable: "--hm-font-nunito-sans",
});

const jetBrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin.woff2",
  weight: "400 500",
  display: "swap",
  variable: "--hm-font-jetbrains-mono",
});

/**
 * Put this on the root element of a page that uses the design system. It
 * loads the fonts for that page only and points the font tokens at them.
 */
export const designSystemFontClassName = [
  sora.variable,
  nunitoSans.variable,
  jetBrainsMono.variable,
  "hm-fonts",
].join(" ");
