'use client';

/**
 * Two-step "Clear all" for the listening history.
 *
 * Wiping the history cannot be undone and the button sits directly above the
 * rows it destroys, so a single click is too cheap. The first press arms it and
 * the second commits; anything else — moving focus away, the Cancel button —
 * disarms. A confirm dialog would do the same job, but the UI kit has no dialog
 * and one destructive button is a poor reason to introduce the dependency.
 */
import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { Button } from '@/components/ui/button';

/**
 * Submit button for the armed state. Separate because `useFormStatus` only
 * reports the surrounding form's state from inside a child of that form.
 */
function ConfirmSubmit({ count }: { readonly count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="sm"
      variant="destructive"
      disabled={pending}
      className="h-7 px-2 text-xs"
    >
      {pending ? 'Clearing…' : `Yes, delete all ${String(count)}`}
    </Button>
  );
}

export function ClearHistoryButton({
  action,
  count,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly count: number;
}) {
  const [armed, setArmed] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Disarm when the interaction moves elsewhere, so a forgotten armed button is
  // never left sitting one stray click away from deleting everything.
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
        Clear all
      </Button>
    );
  }

  return (
    <div ref={wrapperRef} className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">This cannot be undone.</span>
      <form
        action={action}
        onSubmit={() => {
          setArmed(false);
        }}
      >
        <ConfirmSubmit count={count} />
      </form>
      <Button
        type="button"
        size="sm"
        variant="ghost"
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
