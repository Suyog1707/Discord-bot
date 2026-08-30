'use client';

/**
 * "Not like" list manager.
 *
 * The page behind this used to render every dislike a listener had, straight
 * from the server, with one form per row. That is fine at ten rows and hostile
 * at five hundred — the cap — so the list is paged here instead: page one is
 * fetched on mount, "Load more" walks the cursor, and rows can be cleared in
 * bulk rather than one round-trip at a time.
 *
 * Everything goes through the JSON API rather than server actions because the
 * list is now stateful on the client: after a removal the rows already on
 * screen must stay exactly where they are, which a `revalidatePath` refetch of
 * the whole list would undo (and would re-collapse every page the listener has
 * loaded back to the first fifty).
 */
import { ThumbsDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiResponse } from '@discord-music/shared';

import { ListSkeleton } from '@/components/dashboard/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** One rejected song as the API serialises it — `createdAt` crosses as ISO text. */
export interface DislikeRow {
  readonly trackKey: string;
  readonly title: string;
  readonly author: string;
  readonly isrc: string | null;
  readonly source: string;
  readonly createdAt: string;
}

/** Body of `GET /api/user/dislikes`; `total` only comes back on the first page. */
interface DislikePageBody {
  readonly items: readonly DislikeRow[];
  readonly nextCursor: string | null;
  readonly total?: number;
}

const ENDPOINT = '/api/user/dislikes';
const PAGE_SIZE = 50;

/**
 * Hard ceiling the API enforces per listener. Mirrored here only to warn before
 * it bites: hitting it turns the next thumbs-down in Discord into an error, and
 * "why did my 👎 stop working" is a bad way to learn about a limit.
 */
const CAP = 500;
const CAP_WARNING_AT = 450;
/** Keys per bulk request — the remove route's own body cap. */
const BULK_CHUNK = 100;

/** Same-day rejections show a clock, older ones a date — as in History. */
export function formatDislikedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();

  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Unwrap the shared `ApiResponse` envelope, turning a failed one into a throw. */
async function requestJson<TData>(input: string, init?: RequestInit): Promise<TData> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new Error('Could not reach the server.');
  }

  let body: ApiResponse<TData>;
  try {
    body = (await response.json()) as ApiResponse<TData>;
  } catch {
    throw new Error('The server sent something this page could not read.');
  }

  if (!body.success) throw new Error(body.error.message);
  return body.data;
}

/** Every thrown value reaches the user as a sentence, never as `[object Object]`. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

/**
 * Two-step confirm for the bulk removal, in the shape `ClearHistoryButton`
 * established: the first press arms, the second commits, and moving away —
 * Escape, a click elsewhere, an emptied selection — disarms. The UI kit has no
 * dialog and one destructive button is a poor reason to add one.
 */
function RemoveSelectedButton({
  count,
  pending,
  onConfirm,
}: {
  readonly count: number;
  readonly pending: boolean;
  readonly onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!armed) return undefined;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      const node = wrapperRef.current;
      if (node !== null && !node.contains(event.target as Node)) setArmed(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setArmed(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [armed]);

  // An armed button whose selection has gone away would delete the *next*
  // selection on a stray click.
  useEffect(() => {
    if (count === 0) setArmed(false);
  }, [count]);

  if (count === 0) return null;

  if (!armed) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="text-destructive h-7 px-2 text-xs"
        onClick={() => {
          setArmed(true);
        }}
      >
        Remove selected ({String(count)})
      </Button>
    );
  }

  return (
    <div ref={wrapperRef} className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">This cannot be undone.</span>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={pending}
        className="h-7 px-2 text-xs"
        onClick={onConfirm}
      >
        {pending ? 'Removing…' : `Yes, remove ${String(count)}`}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        className="h-7 px-2 text-xs"
        onClick={() => {
          setArmed(false);
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

export function DislikesManager() {
  const [rows, setRows] = useState<readonly DislikeRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  /* ------------------------------------------------------------ first page */
  useEffect(() => {
    const controller = new AbortController();

    requestJson<DislikePageBody>(`${ENDPOINT}?limit=${String(PAGE_SIZE)}`, {
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted) return;
        setRows(page.items);
        setCursor(page.nextCursor);
        setTotal(page.total ?? null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, []);

  /* ------------------------------------------------------------- next page */
  const loadMore = useCallback(() => {
    if (cursor === null) return;
    setError(null);
    setLoadingMore(true);

    requestJson<DislikePageBody>(
      `${ENDPOINT}?cursor=${encodeURIComponent(cursor)}&limit=${String(PAGE_SIZE)}`,
    )
      .then((page) => {
        setRows((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
        if (page.total !== undefined) setTotal(page.total);
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [cursor]);

  /* -------------------------------------------------------------- removals */
  /**
   * Drop keys from the local list without refetching.
   *
   * A key the server reports as *not* deleted is a key that is not there any
   * more either way, so every requested key leaves the list; only the count
   * follows the server's number, which is the one figure a guess could get
   * visibly wrong.
   */
  const forget = useCallback((keys: readonly string[], removed: number) => {
    const gone = new Set(keys);
    setRows((current) => current.filter((row) => !gone.has(row.trackKey)));
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
    setTotal((current) => (current === null ? null : Math.max(current - removed, 0)));
  }, []);

  const removeOne = useCallback(
    (trackKey: string) => {
      setError(null);
      setRemovingKey(trackKey);

      requestJson<{ removed: boolean }>(`${ENDPOINT}/${encodeURIComponent(trackKey)}`, {
        method: 'DELETE',
      })
        .then((result) => {
          forget([trackKey], result.removed ? 1 : 0);
        })
        .catch((cause: unknown) => {
          setError(messageOf(cause));
        })
        .finally(() => {
          setRemovingKey(null);
        });
    },
    [forget],
  );

  const removeSelected = useCallback(() => {
    const keys = rows.map((row) => row.trackKey).filter((key) => selected.has(key));
    if (keys.length === 0) return;
    setError(null);
    setBulkPending(true);

    // One request per hundred keys, not one per row: the bulk route caps a
    // body at 100 (its own abuse guard), and a select-all across several
    // loaded pages can legitimately exceed that. Chunks run sequentially so
    // a failure stops cleanly — everything already removed stays removed,
    // everything not yet attempted stays on screen.
    void (async () => {
      try {
        for (let start = 0; start < keys.length; start += BULK_CHUNK) {
          const chunk = keys.slice(start, start + BULK_CHUNK);
          const result = await requestJson<{ removed: number }>(`${ENDPOINT}/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackKeys: chunk }),
          });
          forget(chunk, result.removed);
        }
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBulkPending(false);
      }
    })();
  }, [forget, rows, selected]);

  /* ------------------------------------------------------------- selection */
  const toggleOne = useCallback((trackKey: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(trackKey)) next.add(trackKey);
      return next;
    });
  }, []);

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.trackKey));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set<string>() : new Set(rows.map((row) => row.trackKey)));
  }, [allSelected, rows]);

  // "Some but not all" has no HTML attribute, only a DOM property.
  useEffect(() => {
    if (selectAllRef.current !== null) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  /* ----------------------------------------------------------------- views */
  if (loading) return <ListSkeleton rows={6} />;

  const busy = bulkPending || loadingMore || removingKey !== null;

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ThumbsDown aria-hidden className="size-5" /> Nothing rejected yet
            </CardTitle>
            <CardDescription>
              Songs you mark 👎 in Discord or here never come back through autoplay. Skips are not
              dislikes.
            </CardDescription>
          </CardHeader>
        </Card>
        {error !== null && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <div className="flex min-w-0 flex-col gap-1">
          <CardDescription>
            {total === null
              ? `${String(rows.length)} rejected track${rows.length === 1 ? '' : 's'}`
              : `${String(rows.length)} of ${String(total)} rejected track${total === 1 ? '' : 's'}`}
          </CardDescription>
          {total !== null && total >= CAP_WARNING_AT && (
            <p className="text-muted-foreground text-xs">
              The list is capped at {String(CAP)} — remove some to make room for new ones.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <input
              ref={selectAllRef}
              type="checkbox"
              className="accent-primary size-4"
              checked={allSelected}
              disabled={busy}
              onChange={toggleAll}
              aria-label="Select all loaded tracks"
            />
            Select all
          </label>
          <RemoveSelectedButton
            count={selected.size}
            pending={bulkPending}
            onConfirm={removeSelected}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex flex-col gap-1">
          {rows.map((row) => (
            <li
              key={row.trackKey}
              className="hover:bg-accent/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                className="accent-primary size-4 shrink-0"
                checked={selected.has(row.trackKey)}
                disabled={busy}
                onChange={() => {
                  toggleOne(row.trackKey);
                }}
                aria-label={`Select ${row.title} by ${row.author}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{row.title}</span>
                <span className="text-muted-foreground block truncate text-xs">{row.author}</span>
              </span>
              <Badge variant="outline" className="shrink-0">
                {row.source}
              </Badge>
              <span
                className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums"
                title={row.createdAt}
              >
                {formatDislikedAt(row.createdAt)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                className="text-destructive h-7 px-2 text-xs"
                onClick={() => {
                  removeOne(row.trackKey);
                }}
              >
                {removingKey === row.trackKey ? 'Removing…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ol>

        {error !== null && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        {cursor !== null && (
          <div>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
