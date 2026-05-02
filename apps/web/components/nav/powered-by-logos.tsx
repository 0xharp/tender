/**
 * Partner-credit row for the site footer ("Powered by · MagicBlock · Cloak").
 *
 * Renders both logos as a single tone driven by `currentColor`, so they pick
 * up whatever text color the parent sets (we use `text-muted-foreground` →
 * mid-grey in both light + dark mode without per-theme overrides).
 *
 * Implementation choices:
 *
 *   - Cloak ships as an SVG. We inline it (instead of `<img>`) so each `<path>`
 *     can be filled with `currentColor` - that's the only way to retint a
 *     vector to whatever the parent text color resolves to.
 *
 *   - MagicBlock ships as a black-on-transparent PNG. SVG `<path>` recolor
 *     doesn't apply, so we use CSS `mask-image` with the PNG as the alpha
 *     source: the resulting box is fully painted with `currentColor`,
 *     visible only where the PNG had pixels. Same monochrome retint result.
 *
 *  Lives in the footer (not as a standalone landing section) - partner
 *  attribution is conventional below-the-fold furniture; surfacing it
 *  mid-page felt placed for placement's sake.
 */
import Link from 'next/link';

export function PoweredByLogos() {
  return (
    <div className="flex flex-col items-center justify-center gap-y-3 text-muted-foreground/80 transition-colors sm:flex-row sm:flex-wrap sm:gap-x-6">
      {/* Stack vertically on mobile - the inline "Powered by ... MagicBlock"
          first row was leaving Cloak orphaned on its own line below with no
          label. Vertical stack gives "Powered by" its own row above the
          logos, then logos sit symmetrically beneath. Switches back to a
          single horizontal row on sm+ where there's enough width. */}
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
        Powered by
      </span>
      <PartnerLink
        href="https://www.magicblock.gg/"
        label="MagicBlock - Private Ephemeral Rollups"
      >
        <MagicBlockMark />
      </PartnerLink>
      {/* Inter-logo dot only makes sense in horizontal layout - hide on
          mobile where logos are stacked vertically (a lone dot between two
          rows reads as visual noise). */}
      <span aria-hidden className="hidden text-muted-foreground/40 sm:inline">
        ·
      </span>
      <PartnerLink href="https://cloak.dev/" label="Cloak - shielded UTXO pool">
        <CloakMark />
      </PartnerLink>
    </div>
  );
}

function PartnerLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className="inline-flex items-center transition-colors hover:text-foreground"
    >
      {children}
    </Link>
  );
}

/** PNG-backed mark - see file header on why mask-image. */
function MagicBlockMark() {
  return (
    <span
      aria-hidden
      className="block h-7 w-44 bg-current"
      style={{
        WebkitMaskImage: "url('/logos/MagicBlock-Logo-Black.png')",
        maskImage: "url('/logos/MagicBlock-Logo-Black.png')",
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }}
    />
  );
}

/** Inline Cloak SVG - every <path> uses currentColor so the wordmark adopts
 *  the parent text color in both themes. Path data lifted verbatim from
 *  `public/logos/cloak-logo.svg`. */
function CloakMark() {
  return (
    <svg
      viewBox="0 0 1537.413 418.67"
      role="img"
      aria-hidden
      className="block h-6 w-auto"
      fill="currentColor"
    >
      <path d="M51.657,212.89c0,15.635,2.694,29.653,8.098,42.047,5.398,12.4,12.839,22.913,22.325,31.537,9.479,8.627,20.795,15.159,33.928,19.607,13.13,4.447,27.428,6.672,42.9,6.672,21.888,0,39.617-3.095,53.187-9.298,13.57-6.197,25.022-14.556,34.365-25.067l32.395,34.769c-5.255,5.932-11.535,11.663-18.825,17.182-7.299,5.528-15.76,10.38-25.39,14.556-9.631,4.18-20.575,7.48-32.832,9.904-12.257,2.427-25.979,3.639-41.15,3.639-23.638,0-45.306-3.375-65.008-10.106-19.699-6.735-36.629-16.44-50.778-29.11-14.161-12.667-25.174-27.96-33.052-45.891C3.939,255.412,0,235.265,0,212.89s3.939-42.517,11.82-60.445c7.878-17.922,18.891-33.215,33.052-45.888,14.149-12.664,31.079-22.369,50.778-29.11,19.702-6.735,41.37-10.106,65.008-10.106,15.171,0,28.893,1.212,41.15,3.639,12.257,2.424,23.201,5.727,32.832,9.904,9.631,4.183,18.092,8.966,25.39,14.354,7.29,5.395,13.57,11.188,18.825,17.384l-32.395,34.769c-9.343-10.51-20.795-18.932-34.365-25.269-13.57-6.331-31.299-9.5-53.187-9.5-15.471,0-29.769,2.222-42.9,6.669-13.133,4.447-24.449,10.986-33.928,19.61-9.485,8.63-16.927,19.14-22.325,31.537-5.404,12.4-8.098,26.549-8.098,42.451Z" />
      <path d="M478.068,349.713l3.048-18.195,3.427-20.374h-115.517V71.382h-51.652v283.008h168.854l-8.161-4.677Z" />
      <path d="M1068.583,71.382h-59.983l-82.117,153.025,13.651,81.304,16.813-31.374h162.852l42.905,80.054h57.768l-151.889-283.008ZM981.032,229.879l57.332-107.148,57.787,107.148h-115.119Z" />
      <path d="M1248.929,71.384h51.657v152.016l130.452-152.016h63.475l-107.251,124.525,150.151,158.486h-67.851l-114.695-120.482-54.28,63.475v57.008h-51.657V71.384Z" />
      <path d="M610.854,236.264c21.525-8.494,46.979-7.239,63.197,9.945,6.004,6.091,11.142,13.713,15.521,21.646-6.828,7.391-16.689,11.574-26.304,12.69-26.924,3.117-51.388-17.86-52.414-44.282h0Z" />
      <path d="M814.735,236.264c-1.028,26.424-25.487,47.398-52.414,44.282-9.617-1.119-19.472-5.299-26.304-12.69,4.369-7.926,9.518-15.562,15.52-21.647,16.216-17.183,41.675-18.44,63.198-9.945h0Z" />
      <path d="M882.139,120.554l-10.319-7.347,5.605-109.534-.01-.016-105.312,38.564L712.793,0l-59.309,42.222L548.174,3.658l-.012.016,5.604,109.534-10.319,7.347-36.183,215.356,13.992,8.009,126.119,72.139,4.582,2.613-4.488-3.446-94.197-72.726-10.641-8.199,10.679-90.807,159.482-111.692,159.482,111.692,10.679,90.807-10.641,8.199-94.197,72.726-4.488,3.446,4.582-2.613,126.12-72.139,13.992-8.009-36.183-215.356ZM568.024,120.232l-1.439-16.15-7.044-79.655,63.013,39.818,16.548,10.452-71.078,45.536ZM859.002,104.081l-1.439,16.15-71.078-45.536,16.548-10.452,63.012-39.818-7.044,79.655Z" />
    </svg>
  );
}
