/**
 * Inline outcome of a server action: muted for success, destructive for errors.
 *
 * Always rendered (empty when idle) so the `aria-live` region exists before the
 * message arrives; screen readers only announce changes to a region that was
 * already in the DOM.
 */
import type { ActionResult } from '@/lib/action-result';
import { cn } from '@/lib/utils';

export function ActionMessage({
  result,
  className,
}: {
  readonly result: ActionResult;
  readonly className?: string;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        'text-xs',
        result.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      {result.status === 'idle' ? null : result.message}
    </p>
  );
}
