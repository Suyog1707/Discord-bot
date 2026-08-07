'use client';

import { BarChart3, Heart, Home, ListMusic, Server, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/** Sidebar sections mirror docs/DASHBOARD.md: Overview, Servers, Player/Queue (per server), Playlists, Analytics, Settings. */
const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview', icon: Home, exact: true },
  { href: '/dashboard/servers', label: 'Servers', icon: Server, exact: false },
  { href: '/dashboard/playlists', label: 'Playlists', icon: ListMusic, exact: false },
  { href: '/dashboard/favorites', label: 'Favorites', icon: Heart, exact: false },
  { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
