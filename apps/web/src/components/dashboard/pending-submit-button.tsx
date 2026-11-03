'use client';

/**
 * Submit button that shows progress while its surrounding form is running.
 *
 * Server-action forms give no feedback by themselves: the page just sits there
 * until the action returns. `useFormStatus` reports the parent form's pending
 * state, but only from a child of that form, so this must be its own component
 * rather than inline in the page.
 */
import { Loader2 } from 'lucide-react';
import { useFormStatus } from 'react-dom';
import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/ui/button';

type PendingSubmitButtonProps = Omit<ComponentProps<typeof Button>, 'type' | 'children'> & {
  /** Resting label. */
  readonly children: ReactNode;
  /** Label while the form is submitting, e.g. "Importing…". */
  readonly pendingLabel: string;
};

export function PendingSubmitButton({
  children,
  pendingLabel,
  disabled,
  ...props
}: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button
      {...props}
      type="submit"
      // Disabled while pending so a double-click cannot start the import twice.
      disabled={disabled === true || pending}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <Loader2 aria-hidden className="animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
