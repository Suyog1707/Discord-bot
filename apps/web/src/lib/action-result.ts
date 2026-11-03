/**
 * Result shape and message helpers for server actions that report back to the
 * user through `useActionState` instead of throwing.
 *
 * A thrown error inside a plain `<form action>` never reaches the UI, so the
 * action catches it and returns a value instead. Messages are built here, in a
 * pure module with no `server-only` import, so they can be unit-tested and so a
 * client component can import the type.
 */
import { userErrorMessage } from '@discord-music/shared';

export type ActionResult =
  | { readonly status: 'idle' }
  | { readonly status: 'success'; readonly message: string }
  | { readonly status: 'error'; readonly message: string };

/** Initial `useActionState` value: nothing has been submitted yet. */
export const IDLE_RESULT: ActionResult = { status: 'idle' };

/**
 * Convert any thrown value into an error result.
 *
 * `userErrorMessage` only passes through messages of expected AppErrors (such
 * as Spotify's 403 explanation) and maps everything else to a generic line, so
 * internal details never reach the browser.
 */
export function errorResult(error: unknown): ActionResult {
  return { status: 'error', message: userErrorMessage(error) };
}

const plural = (count: number): string => `${String(count)} track${count === 1 ? '' : 's'}`;

/** Message for a fresh import or a re-sync started from the importable list. */
export function importSuccessResult(outcome: {
  readonly trackCount: number;
  readonly changed: boolean;
}): ActionResult {
  return {
    status: 'success',
    message: outcome.changed ? `Imported ${plural(outcome.trackCount)}` : 'Already up to date',
  };
}

/** Message for a Sync started from an already-imported playlist's card. */
export function syncSuccessResult(outcome: {
  readonly trackCount: number;
  readonly changed: boolean;
}): ActionResult {
  return {
    status: 'success',
    message: outcome.changed ? `Synced: ${plural(outcome.trackCount)}` : 'Already up to date',
  };
}
