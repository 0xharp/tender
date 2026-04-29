import type { SVGProps } from 'react';

/**
 * Tender wordmark — hexagonal seal with an inscribed "T".
 * 6-sided silhouette nods to "sealed envelope" geometry.
 * Uses currentColor so it adopts the parent's text color.
 */
export function TenderMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M12 2.5 L21 7.5 L21 16.5 L12 21.5 L3 16.5 L3 7.5 Z" />
      <path d="M8 9.25 H16 M12 9.25 V15.5" />
      <circle cx="12" cy="12.25" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
