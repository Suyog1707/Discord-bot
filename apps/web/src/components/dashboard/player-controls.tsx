'use client';

/**
 * Live playback controls.
 *
 * Posts to /api/player/:guildId, which relays to the bot over Redis. State
 * here is optimistic-lite: the button reflects the *requested* state and the
 * page refresh (router.refresh) pulls the persisted truth.
 */
import { Pause, Play, Shuffle, SkipForward, Square, Volume2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { ApiResponse } from '@discord-music/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type PlayerAction =
  | { action: 'pause' | 'resume' | 'skip' | 'stop' | 'shuffle' }
  | { action: 'volume'; volume: number };

export function PlayerControls({
  guildId,
  paused,
  volume,
}: {
  guildId: string;
  paused: boolean;
  volume: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [volumeInput, setVolumeInput] = useState(String(volume));

  function send(action: PlayerAction) {
    startTransition(async () => {
      setError(null);
      try {
        const response = await fetch(`/api/player/${guildId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action),
        });
        const body = (await response.json()) as ApiResponse<{ accepted: boolean }>;
        if (!body.success) {
          setError(body.error.message);
          return;
        }
        // Give the bot a moment to apply + persist before re-reading.
        setTimeout(() => {
          router.refresh();
        }, 800);
      } catch {
        setError('Could not reach the server. Check your connection and try again.');
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {paused ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              send({ action: 'resume' });
            }}
          >
            <Play aria-hidden /> Resume
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              send({ action: 'pause' });
            }}
          >
            <Pause aria-hidden /> Pause
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            send({ action: 'skip' });
          }}
        >
          <SkipForward aria-hidden /> Skip
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            send({ action: 'shuffle' });
          }}
        >
          <Shuffle aria-hidden /> Shuffle
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => {
            send({ action: 'stop' });
          }}
        >
          <Square aria-hidden /> Stop
        </Button>

        <form
          className="ml-auto flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = Number(volumeInput);
            if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 200) {
              send({ action: 'volume', volume: parsed });
            } else {
              setError('Volume must be a whole number between 0 and 200.');
            }
          }}
        >
          <Volume2 aria-hidden className="text-muted-foreground size-4" />
          <Input
            aria-label="Volume percent"
            className="h-8 w-20"
            type="number"
            min={0}
            max={200}
            value={volumeInput}
            onChange={(event) => {
              setVolumeInput(event.target.value);
            }}
          />
          <Button size="sm" variant="outline" type="submit" disabled={pending}>
            Set
          </Button>
        </form>
      </div>

      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
