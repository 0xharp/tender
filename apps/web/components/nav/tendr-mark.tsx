import type { SVGProps } from 'react';

/**
 * tendr.bid wordmark - rounded-square seal with a stylized lowercase "t"
 * and an offset dot signifying the `.bid` TLD. Uses `currentColor` so it
 * adopts whatever text color the parent sets (header, footer, dark mode).
 *
 * Design rationale:
 *   - Rounded square = sealed envelope / bid box
 *   - Lowercase "t" = the brand initial, modern + approachable
 *   - Hooked baseline + offset dot = "t." reads as the start of "tendr.bid"
 */
export function TendrMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Outer seal */}
      <rect x="2.5" y="2.5" width="27" height="27" rx="7.5" />
      {/* t - vertical stroke */}
      <line x1="14" y1="9" x2="14" y2="20" />
      {/* t - cross bar */}
      <line x1="9.5" y1="12.5" x2="18.5" y2="12.5" />
      {/* t - subtle hook at the base */}
      <path d="M14 20 Q14 22 16 22" />
      {/* The "." in .bid */}
      <circle cx="22" cy="22" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
