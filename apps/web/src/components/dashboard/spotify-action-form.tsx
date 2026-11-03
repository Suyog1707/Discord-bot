'use client';

/**
 * A form wired to a Spotify import/sync server action, with inline feedback.
 *
 * `useActionState` hands the action its previous result and re-renders with the
 * new one, so the user sees "Imported 40 tracks" or the reason it failed instead
 * of nothing. The submit button reads the pending state via `PendingSubmitButton`.
 */
import { useActionState, type ReactNode } from 'react';

import { ActionMessage } from '@/components/dashboard/action-message';
import { PendingSubmitButton } from '@/components/dashboard/pending-submit-button';
import { IDLE_RESULT, type ActionResult } from '@/lib/action-result';
import type { ButtonProps } from '@/components/ui/button';

export function SpotifyActionForm({
  action,
  fieldName,
  fieldValue,
  label,
  pendingLabel,
  title,
  variant = 'outline',
  className,
}: {
  readonly action: (previous: ActionResult, formData: FormData) => Promise<ActionResult>;
  /** Name of the hidden input the action reads (`spotifyId` or `playlistId`). */
  readonly fieldName: string;
  readonly fieldValue: string;
  readonly label: ReactNode;
  readonly pendingLabel: string;
  readonly title?: string;
  readonly variant?: ButtonProps['variant'];
  readonly className?: string;
}) {
  const [result, formAction] = useActionState(action, IDLE_RESULT);
  return (
    <form action={formAction} className={className}>
      <input type="hidden" name={fieldName} value={fieldValue} />
      <div className="flex flex-col items-end gap-1">
        <PendingSubmitButton size="sm" variant={variant} pendingLabel={pendingLabel} title={title}>
          {label}
        </PendingSubmitButton>
        <ActionMessage result={result} className="max-w-64 text-right" />
      </div>
    </form>
  );
}
