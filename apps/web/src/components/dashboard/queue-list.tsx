import { QueueRowActions } from '@/components/dashboard/queue-row-actions';
import type { QueueTrackView } from '@/lib/services/guilds';
import { cn, formatDuration } from '@/lib/utils';

/**
 * Read-only queue rendering (server component). The snapshot comes from the
 * database — the bot persists its in-memory queue with a short debounce.
 */
export function QueueList({
  guildId,
  tracks,
  currentIndex,
}: {
  guildId: string;
  tracks: readonly QueueTrackView[];
  currentIndex: number;
}) {
  if (tracks.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        The queue is empty. Start playback with <code className="font-mono">/play</code> in Discord.
      </p>
    );
  }

  return (
    <ol aria-label="Queue" className="flex max-h-96 flex-col gap-1 overflow-y-auto pr-1">
      {tracks.map((track) => {
        const isCurrent = track.position === currentIndex;
        const isPast = track.position < currentIndex;
        const upcomingPosition = track.position - currentIndex;
        const lastPosition = tracks.length - 1 - currentIndex;
        return (
          <li
            key={`${String(track.position)}-${track.title}`}
            className={cn(
              'group flex items-center gap-3 rounded-md px-2 py-1.5 text-sm',
              isCurrent && 'bg-primary/10 border-primary border-l-2',
              isPast && 'opacity-50',
            )}
          >
            <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs">
              {isCurrent ? '▶' : String(track.position + 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
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
              </span>
              <span className="text-muted-foreground block truncate text-xs">{track.author}</span>
            </span>
            <span className="text-muted-foreground shrink-0 font-mono text-xs">
              {track.isStream ? 'LIVE' : formatDuration(track.durationMs)}
            </span>
            {!isCurrent && !isPast && (
              <QueueRowActions
                guildId={guildId}
                position={upcomingPosition}
                isLast={upcomingPosition === lastPosition}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
