'use client';

/**
 * Global navigation progress bar.
 *
 * Dashboard routes are `force-dynamic`, so a click always costs at least one
 * server round trip. The route-level `loading.tsx` skeletons cover the
 * destination, but nothing acknowledged the click itself — the page simply sat
 * there and then swapped. This paints a bar across the top the moment a link
 * goes pending and completes it when the new route commits.
 *
 * `useLinkStatus` only reports from inside a `<Link>`, so the signal is
 * published by {@link LinkPendingSignal} (rendered by `AppLink`) into a tiny
 * module-level store that this bar subscribes to. A counter rather than a
 * boolean, because a fast double-click can leave two links pending at once.
 */
import { Loader2 } from 'lucide-react';
import { useLinkStatus } from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { cn } from '@/lib/utils';

let pendingCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isPending(): boolean {
  return pendingCount > 0;
}

/** Server render never has a navigation in flight. */
function isPendingOnServer(): boolean {
  return false;
}

/**
 * Publishes one link's pending state to the store. Renders nothing; it exists
 * only because `useLinkStatus` has to be called beneath a `<Link>`.
 */
export function LinkPendingSignal(): null {
  const { pending } = useLinkStatus();

  useEffect(() => {
    if (!pending) return;
    pendingCount += 1;
    emit();
    return () => {
      pendingCount -= 1;
      emit();
    };
  }, [pending]);

  return null;
}

/**
 * Spinner for the specific link being followed.
 *
 * The top bar says "something is loading"; this says *which* — worth having in
 * the sidebar, where the destination is otherwise ambiguous until it arrives.
 * Must be rendered as a child of a `<Link>`.
 */
export function LinkSpinner({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Loader2 aria-hidden className={cn('size-3.5 shrink-0 animate-spin', className)} />;
}

/** How long the completed bar stays at 100% before fading out. */
const COMPLETE_MS = 220;

export function RouteProgress() {
  const active = useSyncExternalStore(subscribe, isPending, isPendingOnServer);
  const [visible, setVisible] = useState(false);
  const wasActive = useRef(false);

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      setVisible(true);
      return;
    }
    // Only run the completion flourish for a navigation we actually showed.
    if (!wasActive.current) return;
    wasActive.current = false;
    const timer = setTimeout(() => {
      setVisible(false);
    }, COMPLETE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [active]);

  if (!visible) return null;

  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      aria-busy={active}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
    >
      <div
        className={
          active
            ? 'bg-primary animate-route-progress h-full shadow-[0_0_8px_var(--primary)]'
            : 'bg-primary h-full w-full shadow-[0_0_8px_var(--primary)] transition-opacity duration-200 ease-out [opacity:0]'
        }
      />
    </div>
  );
}
