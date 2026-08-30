import type { Metadata } from 'next';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { DislikesManager } from '@/components/dashboard/dislikes-manager';

export const metadata: Metadata = { title: 'Not like' };
export const dynamic = 'force-dynamic';

const PATH = '/dashboard/dislikes';

/**
 * "Not like" — the songs autoplay must never bring back.
 *
 * The page itself only authenticates and sets the copy; the list is paged,
 * selectable and removable in place, which is client state, so it lives in
 * `DislikesManager` against the JSON API rather than in server actions here.
 */
export default async function DislikesPage() {
  await requireUserOrRedirect(PATH);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Not like</h1>
        <p className="text-muted-foreground">
          Songs you marked 👎 in Discord or here never come back through autoplay. Skips are not
          dislikes — a skip only nudges what gets suggested, this shuts a song out entirely.
        </p>
      </div>

      <DislikesManager />
    </div>
  );
}
