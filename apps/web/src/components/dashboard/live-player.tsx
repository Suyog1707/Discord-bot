'use client';

/**
 * Real-time player view.
 *
 * Subscribes to the guild's SSE stream; every bot-side change arrives as a
 * full state snapshot, so rendering is a pure function of the latest event —
 * no reconciliation, no polling, no page refresh. Between events the progress
 * bar advances locally from (positionMs, receivedAt). If the stream drops,
 * EventSource reconnects automatically and the next snapshot corrects
 * everything; until then the last known state stays visible with a "live"
 * indicator turned off.
 *
 * Commands still flow through POST /api/player/:guildId — their effects come
 * back through this stream, closing the loop.
 */
import {
  ListMusic,
  Pause,
  Play,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  ThumbsDown,
  Volume2,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ApiResponse,
  PlayerEvent,
  PlayerSnapshot,
  TrackSnapshot,
} from '@discord-music/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn, formatDuration } from '@/lib/utils';

type Command =
  | { action: 'pause' | 'resume' | 'skip' | 'stop' | 'shuffle' | 'previous' }
  | { action: 'volume'; volume: number }
  | { action: 'jump' | 'remove'; position: number }
  | { action: 'loop'; mode: 'off' | 'track' | 'queue' };

export function LivePlayer({
  guildId,
  initial,
}: {
  guildId: string;
  initial: PlayerSnapshot | null;
}) {
  const [state, setState] = useState<PlayerSnapshot | null>(initial);
  const [live, setLive] = useState(false);
  const [positionMs, setPositionMs] = useState(initial?.positionMs ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<string | null>(null);
  const stateRef = useRef<{ state: PlayerSnapshot | null; receivedAt: number }>({
    state: initial,
    receivedAt: Date.now(),
  });

  /* ------------------------------------------------------------ SSE intake */
  useEffect(() => {
    const source = new EventSource(`/api/server/${guildId}/events`);

    source.onopen = () => {
      setLive(true);
    };
    source.onerror = () => {
      setLive(false); // EventSource retries by itself
    };
    source.onmessage = (message: MessageEvent<string>) => {
      let event: PlayerEvent;
      try {
        event = JSON.parse(message.data) as PlayerEvent;
      } catch {
        return;
      }
      const now = Date.now();
      stateRef.current = { state: event.state, receivedAt: now };
      setState(event.state);
      setPositionMs(event.state?.positionMs ?? 0);
    };

    return () => {
      source.close();
    };
  }, [guildId]);

  /* --------------------------------------------------- local progress tick */
  useEffect(() => {
    const timer = setInterval(() => {
      const { state: current, receivedAt: since } = stateRef.current;
      if (current === null || current.paused || current.current === null) return;
      if (current.current.isStream) return;
      setPositionMs(
        Math.min(current.positionMs + (Date.now() - since), current.current.durationMs),
      );
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  /* ---------------------------------------------------------------- errors */
  const send = useCallback(
    (command: Command) => {
      setError(null);
      fetch(`/api/player/${guildId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      })
        .then(async (response) => {
          const body = (await response.json()) as ApiResponse<{ accepted: boolean }>;
          if (!body.success) setError(body.error.message);
        })
        .catch(() => {
          setError('Could not reach the server.');
        });
    },
    [guildId],
  );

  /**
   * "Not like this song" — a listener preference, not guild control, so it goes
   * to the user route rather than the player one and needs no Manage Server.
   * The bot picks it up over the same command channel and skips the track;
   * `trackKey` is the bot's own canonical identity for the recording, so the
   * rejection survives the same song arriving from a different provider.
   */
  const dislike = useCallback(
    (current: TrackSnapshot) => {
      setError(null);
      fetch('/api/user/dislikes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: current.title,
          author: current.author,
          trackKey: current.trackKey,
          guildId,
          skipIfPlaying: true,
        }),
      })
        .then(async (response) => {
          const body = (await response.json()) as ApiResponse<{ added: boolean }>;
          if (!body.success) setError(body.error.message);
        })
        .catch(() => {
          setError('Could not reach the server.');
        });
    },
    [guildId],
  );

  if (state?.current == null) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-sm">
        <Radio aria-hidden className={cn('size-6', live && 'text-success')} />
        Nothing is playing. Start something with <code className="font-mono">/play</code> — this
        view updates live.
      </div>
    );
  }

  const track = state.current;
  const progress =
    track.isStream || track.durationMs === 0 ? 1 : Math.min(positionMs / track.durationMs, 1);
  const remainingMs = Math.max(track.durationMs - positionMs, 0);
  const loopNext =
    state.loopMode === 'off' ? 'track' : state.loopMode === 'track' ? 'queue' : 'off';

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------------------ now playing */}
      <div className="flex items-start gap-4">
        {track.artworkUrl !== null ? (
          <Image
            src={track.artworkUrl}
            alt=""
            width={96}
            height={96}
            unoptimized
            className="size-24 shrink-0 rounded-md object-cover"
          />
        ) : (
          <div className="bg-muted flex size-24 shrink-0 items-center justify-center rounded-md">
            <ListMusic aria-hidden className="text-muted-foreground size-8" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-block size-2 shrink-0 rounded-full',
                live ? 'bg-success animate-pulse' : 'bg-muted-foreground',
              )}
              title={live ? 'Live' : 'Reconnecting…'}
            />
            <p className="truncate text-lg font-semibold">
              {track.uri !== null ? (
                <a
                  href={track.uri}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:underline"
                >
                  {track.title}
                </a>
              ) : (
                track.title
              )}
            </p>
          </div>
          <p className="text-muted-foreground truncate text-sm">{track.author}</p>
          <div className="mt-2">
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full transition-[width] duration-1000 ease-linear"
                style={{ width: `${String(progress * 100)}%` }}
              />
            </div>
            <div className="text-muted-foreground mt-1 flex justify-between font-mono text-xs">
              <span>{track.isStream ? '🔴 LIVE' : formatDuration(positionMs)}</span>
              <span>{track.isStream ? '' : `-${formatDuration(remainingMs)}`}</span>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {state.paused && <Badge variant="secondary">Paused</Badge>}
            <Badge variant="outline">{track.source}</Badge>
            <Badge variant="outline">requested by {track.requestedByName}</Badge>
            {state.loopMode !== 'off' && <Badge variant="secondary">loop: {state.loopMode}</Badge>}
            {state.autoplayEnabled && <Badge variant="secondary">autoplay</Badge>}
            {state.stayConnected && <Badge variant="secondary">24/7</Badge>}
            {state.activeFilter !== null && (
              <Badge variant="secondary">filter: {state.activeFilter}</Badge>
            )}
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            send({ action: 'previous' });
          }}
        >
          <SkipBack aria-hidden /> Previous
        </Button>
        {state.paused ? (
          <Button
            size="sm"
            onClick={() => {
              send({ action: 'resume' });
            }}
          >
            <Play aria-hidden /> Resume
          </Button>
        ) : (
          <Button
            size="sm"
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
          onClick={() => {
            send({ action: 'skip' });
          }}
        >
          <SkipForward aria-hidden /> Skip
        </Button>
        <Button
          size="sm"
          variant="secondary"
          title="Never recommend this song to me again"
          onClick={() => {
            dislike(track);
          }}
        >
          <ThumbsDown aria-hidden /> Not like
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            send({ action: 'shuffle' });
          }}
        >
          <Shuffle aria-hidden /> Shuffle
        </Button>
        <Button
          size="sm"
          variant={state.loopMode === 'off' ? 'secondary' : 'default'}
          onClick={() => {
            send({ action: 'loop', mode: loopNext });
          }}
        >
          {state.loopMode === 'track' ? <Repeat1 aria-hidden /> : <Repeat aria-hidden />}
          Loop: {state.loopMode}
        </Button>
        <Button
          size="sm"
          variant="destructive"
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
            const parsed = Number(volumeDraft ?? state.volume);
            if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 200) {
              send({ action: 'volume', volume: parsed });
              setVolumeDraft(null);
            } else {
              setError('Volume must be a whole number between 0 and 200.');
            }
          }}
        >
          <Volume2 aria-hidden className="text-muted-foreground size-4" />
          <Input
            aria-label="Volume percent"
            className="h-8 w-20"
            inputMode="numeric"
            value={volumeDraft ?? String(state.volume)}
            onChange={(event) => {
              setVolumeDraft(event.target.value);
            }}
          />
          <Button type="submit" size="sm" variant="outline">
            Set
          </Button>
        </form>
      </div>

      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {/* ------------------------------------------------------- live queue */}
      <div>
        <p className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wide">
          Up next — {String(state.upcomingTotal)} track{state.upcomingTotal === 1 ? '' : 's'}
        </p>
        {state.upcoming.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Queue is empty{state.autoplayEnabled ? ' — autoplay will continue the vibe.' : '.'}
          </p>
        ) : (
          <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
            {state.upcoming.map((upcomingTrack, index) => (
              <li
                key={`${upcomingTrack.identifier}-${String(index)}`}
                className="group flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
              >
                <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs">
                  {String(index + 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{upcomingTrack.title}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {upcomingTrack.author} · {upcomingTrack.requestedByName}
                  </span>
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {upcomingTrack.isStream ? 'LIVE' : formatDuration(upcomingTrack.durationMs)}
                </span>
                <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    title="Play now"
                    onClick={() => {
                      send({ action: 'jump', position: index + 1 });
                    }}
                  >
                    <Play aria-hidden className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive size-6"
                    title="Remove"
                    onClick={() => {
                      send({ action: 'remove', position: index + 1 });
                    }}
                  >
                    <X aria-hidden className="size-3.5" />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
