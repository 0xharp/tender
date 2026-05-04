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
      <PartnerLink href="https://www.magicblock.gg/" label="MagicBlock - Private Ephemeral Rollups">
        <MagicBlockMark />
      </PartnerLink>
      {/* Inter-logo dot only makes sense in horizontal layout - hide on
          mobile where logos are stacked vertically (a lone dot between two
          rows reads as visual noise). */}
      <span aria-hidden className="hidden text-muted-foreground/40 sm:inline">
        ·
      </span>
      <PartnerLink href="https://cloak.ag/" label="Cloak - shielded UTXO pool">
        <CloakMark />
      </PartnerLink>
      <span aria-hidden className="hidden text-muted-foreground/40 sm:inline">
        ·
      </span>
      <PartnerLink href="https://www.sns.id/" label="Solana Name Service - .sol identity">
        <SnsMark />
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

/** Inline SNS mark - the brand SVG ships with hardcoded fills (green leaf
 *  + light grey wordmark). We override both to `currentColor` here so it
 *  matches the muted-monochrome treatment of MagicBlock + Cloak in the
 *  footer; if we ever want the green leaf to pop for a campaign surface,
 *  switch to `<img src="/logos/sns-logo.svg">` to preserve brand colors. */
function SnsMark() {
  return (
    <svg
      viewBox="0 0 115 40"
      role="img"
      aria-hidden
      className="block h-6 w-auto"
      fill="currentColor"
    >
      <title>Solana Name Service</title>
      <path d="m32.232 17.056 2.458-1.42v-5.64l-4.884-2.82-2.459 1.422a3.437 3.437 0 0 1-5.093-3.013l-.001-2.766L17.371 0l-.026.015L17.319 0l-4.882 2.82v2.765a3.437 3.437 0 0 1-5.093 3.013l-2.46-1.421L0 9.997v5.64l2.46 1.419a3.438 3.438 0 0 1-.064 5.917L0 24.356v5.637l.001.001v.008l4.883 2.818 2.393-1.383a3.441 3.441 0 0 1 5.16 2.978v2.766L17.319 40l.026-.015.026.015 4.882-2.82.001-2.765a3.438 3.438 0 0 1 5.159-2.977l2.393 1.382L34.69 30v-5.646l-2.394-1.382a3.437 3.437 0 0 1-.063-5.917Zm-4.912 5.916-2.395 1.383v.008h-.001v2.765a3.44 3.44 0 0 1-5.158 2.979l-2.395-1.383-.026.014-.026-.014-2.395 1.383a3.44 3.44 0 0 1-5.158-2.979v-2.773L7.37 22.973a3.436 3.436 0 0 1-.076-5.908l2.47-1.428v-2.764a3.438 3.438 0 0 1 5.16-2.979l2.394 1.382.026-.014.026.014 2.395-1.382a3.439 3.439 0 0 1 5.158 2.979v2.764l2.47 1.428a3.434 3.434 0 0 1-.074 5.908Z" />
      <path d="M55.708 32.271c-1.4.009-2.793-.185-4.138-.575a8.107 8.107 0 0 1-3.452-2.075 7.863 7.863 0 0 1-1.681-2.499 7.422 7.422 0 0 1-.608-2.924v-.265h4.357l.01.255c.011.675.185 1.338.507 1.933a4.786 4.786 0 0 0 1.24 1.433c.53.387 1.14.648 1.786.762.71.145 1.434.218 2.16.22a9.552 9.552 0 0 0 2.174-.24 4.397 4.397 0 0 0 1.852-.96l.015-.013a2.37 2.37 0 0 0 .729-.936c.193-.417.293-.872.29-1.332a2.585 2.585 0 0 0-.82-1.974 4.4 4.4 0 0 0-2.514-1.013c-.242-.03-.568-.074-.997-.136-.407-.058-.849-.116-1.35-.18-.48-.06-.969-.12-1.465-.18a40.331 40.331 0 0 1-1.34-.182 7.32 7.32 0 0 1-4.235-2.04 6.017 6.017 0 0 1-1.587-4.36c0-.906.201-1.8.59-2.618a7.212 7.212 0 0 1 1.384-2.038 8.188 8.188 0 0 1 2.934-1.91c1.27-.48 2.62-.715 3.979-.695a12.033 12.033 0 0 1 4.291.74A7.436 7.436 0 0 1 63 10.714c.514.6.93 1.278 1.236 2.007.313.809.466 1.671.448 2.539v.265h-4.353l-.013-.252a3.754 3.754 0 0 0-.4-1.54c-.206-.419-.484-.799-.822-1.121a5.169 5.169 0 0 0-3.568-1.15 6.857 6.857 0 0 0-2.556.429 3.88 3.88 0 0 0-1.586 1.2 2.691 2.691 0 0 0-.559 1.627 2.301 2.301 0 0 0 .714 1.892c.627.456 1.362.74 2.132.825.632.09 1.404.189 2.291.292.902.106 1.985.266 3.219.476a7.775 7.775 0 0 1 4.271 2.149 5.99 5.99 0 0 1 1.772 4.431c.016.941-.16 1.876-.518 2.746a7.114 7.114 0 0 1-1.36 2.086 7.897 7.897 0 0 1-3.363 2.034 14.276 14.276 0 0 1-4.277.621ZM105.236 32.271a14.51 14.51 0 0 1-4.137-.575 8.107 8.107 0 0 1-3.452-2.075 7.863 7.863 0 0 1-1.682-2.499 7.422 7.422 0 0 1-.608-2.924v-.265h4.357l.01.255c.012.675.186 1.338.507 1.933a4.788 4.788 0 0 0 1.241 1.433 4.29 4.29 0 0 0 1.785.762c.711.145 1.435.218 2.16.22a9.554 9.554 0 0 0 2.174-.24 4.396 4.396 0 0 0 1.852-.96l.016-.013c.318-.245.569-.567.728-.936.194-.417.293-.872.291-1.332a2.593 2.593 0 0 0-.82-1.974 4.402 4.402 0 0 0-2.514-1.013 50.55 50.55 0 0 1-.998-.136 86.255 86.255 0 0 0-1.349-.18l-1.466-.18a40.413 40.413 0 0 1-1.34-.182 7.322 7.322 0 0 1-4.234-2.04 6.017 6.017 0 0 1-1.587-4.36c0-.906.2-1.8.59-2.618a7.212 7.212 0 0 1 1.383-2.038 8.188 8.188 0 0 1 2.934-1.91 10.813 10.813 0 0 1 3.979-.695 12.033 12.033 0 0 1 4.292.74 7.43 7.43 0 0 1 3.18 2.246c.514.6.931 1.278 1.236 2.007.314.809.466 1.671.449 2.539v.265h-4.354l-.012-.252a3.77 3.77 0 0 0-.4-1.54c-.206-.419-.485-.799-.823-1.121a5.17 5.17 0 0 0-3.568-1.15 6.862 6.862 0 0 0-2.556.429c-.624.256-1.17.67-1.586 1.2a2.69 2.69 0 0 0-.558 1.627 2.297 2.297 0 0 0 .714 1.892c.627.456 1.361.74 2.131.825.632.09 1.404.189 2.292.292a63.98 63.98 0 0 1 3.218.476 7.778 7.778 0 0 1 4.272 2.149 5.995 5.995 0 0 1 1.771 4.431 6.89 6.89 0 0 1-.518 2.746 7.1 7.1 0 0 1-1.36 2.086 7.891 7.891 0 0 1-3.363 2.034 14.272 14.272 0 0 1-4.277.621ZM85.91 31.684V16.931c0-1.646-.368-2.942-1.093-3.852-.711-.892-1.94-1.345-3.652-1.345-1-.016-1.978.307-2.772.916a6.782 6.782 0 0 0-1.954 2.456 7.91 7.91 0 0 0-.674 2.79 42.595 42.595 0 0 0-.112 2.916v10.872h-4.367V8.317h3.847l.258 2.804c.243-.377.528-.725.85-1.037a7.655 7.655 0 0 1 1.777-1.286 9.673 9.673 0 0 1 2.042-.789c.67-.18 1.36-.274 2.053-.28 2.683 0 4.739.774 6.11 2.3 1.363 1.519 2.054 3.659 2.054 6.361v15.296H85.91Z" />
    </svg>
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
      <title>Cloak</title>
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
