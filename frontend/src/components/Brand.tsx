// Brand — the AnswerLabs logo.
//
// Drawn in SVG from the brand sheet rather than shipped as an image, so it stays
// sharp at every size from a 16px favicon to the sign-in page.
//
// The SHAPE is the brand sheet's; the COLOURS are the site's. The sheet's
// blue→violet clashed with the emerald product, so every colour here is a
// --logo-* variable that styles.css derives from the theme's own --primary and
// --primary-glow: deep emerald on light surfaces, mint on dark, and whatever the
// theme becomes next. The hex fallbacks are the light theme, for any surface
// outside the stylesheet. public/favicon.svg carries the same paths and colours —
// keep the two in step if the mark ever changes.
//
//   LogoMark — the "A" with the star in its counter (the "answer").
//   Wordmark — "Answer" in ink, "Labs" in the theme green, set in Outfit.
//   Logo     — the two side by side, optionally with the tagline.

import { useId } from "react";

/** The "A": broad rounded top, legs that thicken toward the feet, and the right
 *  foot swept into a hook — the "bridge" in the brand concept. */
const A_PATH =
  "M7 94Q2 94 3.87 89.4L35.3 11.6Q37.5 6 43.5 6L56.5 6Q62.5 6 64.7 11.6L96.13 89.4Q98 94 93 94L60 94Q75.4 88.5 70.26 77.7L51.93 39.07Q50 35 48.07 39.07L23.29 91.29Q22 94 19 94Z";
/** Four-point star, concave-sided, sitting in the counter of the A. */
const STAR_PATH =
  "M50 56.7C50.7 67.5 53.5 71.3 63.2 72C53.5 72.7 50.7 76.5 50 87.3C49.3 76.5 46.5 72.7 36.8 72C46.5 71.3 49.3 67.5 50 56.7Z";
/** A shaded fold down the outer edge of the right leg, clipped to the A. */
const FOLD_PATH = "M58 0L100 0L100 100L86 100Z";

export const BRAND_TAGLINE = "Bridging conversations";

export function LogoMark({ className = "w-8 h-8", title }: { className?: string; title?: string }) {
  // Gradient and clip ids must be unique per instance: a duplicate id resolves to
  // the FIRST element in the document, and when that copy sits in a hidden subtree
  // (the sign-in art panel is display:none below lg) the gradient paints nothing.
  const id = `al${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <svg
      viewBox="0 0 100 100"
      className={`shrink-0 ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}g`} x1="28" y1="0" x2="98" y2="94" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "var(--logo-from, #0e9a6a)" }} />
          <stop offset=".55" style={{ stopColor: "var(--logo-mid, #07724f)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-to, #05543a)" }} />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="20" x2="0" y2="94" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopOpacity="0" style={{ stopColor: "var(--logo-fold, #03382a)" }} />
          <stop offset="1" stopOpacity=".3" style={{ stopColor: "var(--logo-fold, #03382a)" }} />
        </linearGradient>
        <clipPath id={`${id}c`}>
          <path d={A_PATH} />
        </clipPath>
      </defs>
      <path d={A_PATH} fill={`url(#${id}g)`} />
      <path d={FOLD_PATH} fill={`url(#${id}f)`} clipPath={`url(#${id}c)`} />
      {/* --brand-star is set to white under .dark in styles.css. */}
      <path d={STAR_PATH} style={{ fill: `var(--brand-star, url(#${id}g))` }} />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-brand font-bold tracking-tight whitespace-nowrap ${className}`}>
      Answer<span className="text-brand-gradient">Labs</span>
    </span>
  );
}

const SIZES = {
  sm: { mark: "w-7 h-7", text: "text-lg", gap: "gap-2" },
  md: { mark: "w-8 h-8", text: "text-xl", gap: "gap-2.5" },
  lg: { mark: "w-11 h-11", text: "text-3xl", gap: "gap-3" },
};

export function Logo({
  size = "md",
  tagline = false,
  suffix,
  className = "",
}: {
  size?: keyof typeof SIZES;
  /** "BRIDGING CONVERSATIONS" under the wordmark — for roomy placements only. */
  tagline?: boolean;
  /** A quiet label after the wordmark, e.g. "Admin". */
  suffix?: string;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <span className={`inline-flex items-center ${s.gap} ${className}`}>
      <LogoMark className={s.mark} />
      <span className="flex flex-col">
        <span className="flex items-baseline gap-1.5 leading-none">
          <Wordmark className={s.text} />
          {suffix && <span className="text-xs font-normal text-muted-foreground">{suffix}</span>}
        </span>
        {tagline && (
          <span className="mt-1.5 font-brand font-medium text-[9px] uppercase tracking-[0.32em] text-muted-foreground whitespace-nowrap">
            {BRAND_TAGLINE}
          </span>
        )}
      </span>
    </span>
  );
}
