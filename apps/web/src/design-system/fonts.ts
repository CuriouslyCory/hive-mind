import { JetBrains_Mono, Nunito_Sans, Sora } from "next/font/google";

// The three faces from the brand book (docs/design-system.md → Type). Each
// declares a CSS variable on the element that carries its class; tokens.css
// reads those variables inside `.hm-fonts` to build --font-display,
// --font-sans and --font-mono.
const sora = Sora({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
  variable: "--hm-font-sora",
});

const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
  variable: "--hm-font-nunito-sans",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
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
