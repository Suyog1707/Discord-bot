import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Placeholder block shown while server data is in flight.
 *
 * Used by the route-level `loading.tsx` boundaries so a navigation paints
 * immediately instead of leaving the previous page frozen on screen.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('bg-accent animate-pulse rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };
