'use client';

/**
 * "Invite bot" button that flips to "Manage" without a manual reload.
 *
 * The invite is completed on Discord in a separate tab, so nothing ever tells
 * this page it happened — the card kept showing "Invite bot" until the user
 * reloaded. After the click we poll `/api/server` (the same list the page was
 * rendered from) until the bot appears in this guild, then `router.refresh()`
 * re-renders the server component and the card swaps to the manage link.
 *
 * Two details matter: polling is bounded, so an abandoned invite cannot leave a
 * tab requesting forever, and a tab returning to the foreground is checked
 * immediately rather than waiting out the interval — background tabs have their
 * timers throttled, which is exactly the state this tab is in while the user is
 * on Discord.
 */
import { ExternalLink, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { ApiResponse } from '@discord-music/shared';

import { Button } from '@/components/ui/button';

const POLL_INTERVAL_MS = 3_000;
/** Give up after this long; the user may have closed the Discord tab. */
const POLL_TIMEOUT_MS = 120_000;

/** The subset of `ServerListEntry` this component reads. */
interface ServerPresence {
  readonly discordId: string;
  readonly botPresent: boolean;
}

export function InviteBotButton({ guildId, inviteUrl }: { guildId: string; inviteUrl: string }) {
  const router = useRouter();
  const [waiting, setWaiting] = useState(false);
  /** Bumped on every click so a second attempt restarts the poll from scratch. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!waiting) return;

    const controller = new AbortController();
    const { signal } = controller;
    /** Read through a call so narrowing cannot make later checks look constant. */
    const stale = (): boolean => signal.aborted;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    async function check(): Promise<void> {
      if (stale() || checking) return;
      checking = true;

      try {
        const response = await fetch('/api/server', { cache: 'no-store', signal });
        const body = (await response.json()) as ApiResponse<readonly ServerPresence[]>;
        if (
          body.success &&
          body.data.some((server) => server.discordId === guildId && server.botPresent)
        ) {
          if (!stale()) {
            setWaiting(false);
            router.refresh();
          }
          return;
        }
      } catch {
        // Offline, rate limited, or a transient error: try again on the next tick.
      } finally {
        checking = false;
      }

      if (stale()) return;
      if (Date.now() >= deadline) {
        setWaiting(false);
        // The bot may have been added to a different server than the one this
        // card offered; one refresh lets the rest of the list catch up too.
        router.refresh();
        return;
      }
      timer = setTimeout(() => {
        void check();
      }, POLL_INTERVAL_MS);
    }

    function checkNow(): void {
      if (document.visibilityState !== 'visible') return;
      if (timer !== undefined) clearTimeout(timer);
      void check();
    }

    void check();
    document.addEventListener('visibilitychange', checkNow);
    window.addEventListener('focus', checkNow);

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkNow);
      window.removeEventListener('focus', checkNow);
    };
  }, [waiting, attempt, guildId, router]);

  return (
    <Button asChild variant="outline" className="w-full">
      <a
        href={inviteUrl}
        target="_blank"
        rel="noreferrer noopener"
        onClick={() => {
          setWaiting(true);
          setAttempt((value) => value + 1);
        }}
      >
        {waiting ? (
          <>
            <Loader2 aria-hidden className="animate-spin" /> Waiting for invite…
          </>
        ) : (
          <>
            <ExternalLink aria-hidden /> Invite bot
          </>
        )}
      </a>
    </Button>
  );
}
