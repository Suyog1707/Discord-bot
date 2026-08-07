'use client';

/**
 * Per-row queue editing: play now, move up/down, remove.
 *
 * Positions are 1-based within the *upcoming* tracks — the same numbering the
 * bot's /queue command shows — so the payloads match the shared
 * player-command schema exactly.
 */
import { ArrowDown, ArrowUp, Play, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import type { ApiResponse } from '@discord-music/shared';

import { Button } from '@/components/ui/button';

type RowAction =
  | { action: 'jump'; position: number }
  | { action: 'remove'; position: number }
  | { action: 'move'; from: number; to: number };

export function QueueRowActions({
  guildId,
  position,
  isLast,
}: {
  guildId: string;
  /** 1-based position within upcoming tracks. */
  position: number;
  isLast: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function send(action: RowAction) {
    startTransition(async () => {
      try {
        const response = await fetch(`/api/player/${guildId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action),
        });
        const body = (await response.json()) as ApiResponse<{ accepted: boolean }>;
        if (body.success) {
          setTimeout(() => {
            router.refresh();
          }, 800);
        }
      } catch {
        // The next refresh shows the authoritative state either way.
      }
    });
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        title="Play now"
        disabled={pending}
        onClick={() => {
          send({ action: 'jump', position });
        }}
      >
        <Play aria-hidden className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        title="Move up"
        disabled={pending || position === 1}
        onClick={() => {
          send({ action: 'move', from: position, to: position - 1 });
        }}
      >
        <ArrowUp aria-hidden className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        title="Move down"
        disabled={pending || isLast}
        onClick={() => {
          send({ action: 'move', from: position, to: position + 1 });
        }}
      >
        <ArrowDown aria-hidden className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="text-destructive size-6"
        title="Remove"
        disabled={pending}
        onClick={() => {
          send({ action: 'remove', position });
        }}
      >
        <X aria-hidden className="size-3.5" />
      </Button>
    </span>
  );
}
