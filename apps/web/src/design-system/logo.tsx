import Image from "next/image";
import { cx } from "./cx";

/**
 * The logo files in apps/web/public/brand, downscaled from the design
 * system's originals (never redrawn, recoloured or cropped). Width and height
 * are the files' pixel sizes.
 */
export const brandAssets = {
  mark: { src: "/brand/hivemind-mark.png", width: 122, height: 128 },
  wordmark: { src: "/brand/hivemind-wordmark.png", width: 506, height: 108 },
  lockup: { src: "/brand/hivemind-lockup.png", width: 600, height: 600 },
} as const;

function widthAt(asset: { width: number; height: number }, height: number): number {
  return Math.round((asset.width / asset.height) * height);
}

export type LogoProps = {
  /** Show the hexagon mark. Defaults to true. */
  mark?: boolean;
  /** Show the HiveMind wordmark. Defaults to true. */
  wordmark?: boolean;
  /** Height of the wordmark in px; the mark is drawn 32/28 of it, as in the header. Defaults to 28. */
  height?: number;
  /**
   * Sit the logo on the white logo tile. Defaults to true; the brand book
   * keeps the logo on white over dark surfaces until a dark variant exists.
   */
  tile?: boolean;
  /** `eager` for a logo above the fold (the header). Defaults to the browser's lazy loading. */
  loading?: "eager" | "lazy";
  className?: string;
};

/** Mark plus wordmark on the white logo tile. The accessible name is "HiveMind". */
export function Logo({
  mark = true,
  wordmark = true,
  height = 28,
  tile = true,
  loading,
  className,
}: LogoProps) {
  const markHeight = wordmark ? Math.round((height * 32) / 28) : height;
  return (
    <span className={cx(tile ? "hm-logo-tile" : "hm-logo-bare", className)}>
      {mark ? (
        <Image
          src={brandAssets.mark.src}
          width={widthAt(brandAssets.mark, markHeight)}
          height={markHeight}
          alt={wordmark ? "" : "HiveMind"}
          loading={loading}
        />
      ) : null}
      {wordmark ? (
        <Image
          src={brandAssets.wordmark.src}
          width={widthAt(brandAssets.wordmark, height)}
          height={height}
          alt="HiveMind"
          loading={loading}
        />
      ) : null}
    </span>
  );
}

export type LogoLockupProps = {
  /** Width and height in px (the lockup is square). Defaults to 200. */
  size?: number;
  /** `eager` when the lockup is above the fold. */
  loading?: "eager" | "lazy";
  className?: string;
};

/** The stacked lockup (mark over wordmark) for heroes and calls to action. */
export function LogoLockup({ size = 200, loading, className }: LogoLockupProps) {
  return (
    <Image
      src={brandAssets.lockup.src}
      width={size}
      height={size}
      alt="HiveMind"
      loading={loading}
      className={cx("hm-lockup", className)}
    />
  );
}
