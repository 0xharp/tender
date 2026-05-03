'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

export interface NavLink {
  href: string;
  label: string;
  /** Mark the link active when pathname starts with this prefix (defaults to exact match). */
  matchPrefix?: string;
  /** Hide unless signed in. */
  authOnly?: boolean;
}

export const PUBLIC_LINKS: NavLink[] = [
  { href: '/rfps', label: 'Browse RFPs', matchPrefix: '/rfps' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/docs', label: 'Docs', matchPrefix: '/docs' },
];

export const AUTHED_LINKS: NavLink[] = [
  { href: '/dashboard', label: 'Dashboard', matchPrefix: '/dashboard', authOnly: true },
  { href: '/me/projects', label: 'My projects', matchPrefix: '/me/projects', authOnly: true },
];

export function NavLinks({
  signedIn,
  variant = 'desktop',
  onNavigate,
}: {
  signedIn: boolean;
  variant?: 'desktop' | 'mobile';
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const links = [...(signedIn ? AUTHED_LINKS : []), ...PUBLIC_LINKS];

  return (
    <nav
      className={cn(
        variant === 'desktop' ? 'hidden items-center gap-1 md:flex' : 'flex flex-col gap-1',
      )}
    >
      {links.map((link) => {
        const active = link.matchPrefix
          ? pathname.startsWith(link.matchPrefix)
          : pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            className={cn(
              'relative rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              variant === 'mobile' && 'py-3 text-base',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {link.label}
            {active && variant === 'desktop' && (
              <span className="absolute -bottom-[13px] left-1/2 h-px w-8 -translate-x-1/2 bg-gradient-to-r from-transparent via-primary to-transparent" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
