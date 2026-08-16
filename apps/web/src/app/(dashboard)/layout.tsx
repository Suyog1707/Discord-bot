import { AppLink } from '@/components/navigation/app-link';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { UserBadge } from '@/components/auth/user-badge';
import { DashboardNav } from '@/components/dashboard/nav';

/**
 * Authenticated shell: sidebar navigation + top bar.
 *
 * This layout is the authoritative auth boundary — the middleware only checks
 * cookie presence; this validates the session against the database and
 * redirects to /login when it is missing or expired.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUserOrRedirect('/dashboard');

  return (
    <div className="flex min-h-dvh">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center px-4">
          <AppLink href="/dashboard" className="text-sm font-semibold tracking-tight">
            Discord Music
          </AppLink>
        </div>
        <DashboardNav />
        <div className="border-sidebar-border mt-auto border-t p-3">
          <UserBadge user={user} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b px-4 backdrop-blur md:justify-end">
          <AppLink href="/dashboard" className="text-sm font-semibold md:hidden">
            Discord Music
          </AppLink>
          <SignOutButton />
        </header>
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
