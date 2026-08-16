'use client';

/**
 * `next/link` that reports its pending state to the global progress bar.
 *
 * Use this for in-app navigation; plain `next/link` stays correct, it just
 * navigates without lighting up the top bar.
 */
import Link from 'next/link';
import type * as React from 'react';

import { LinkPendingSignal } from './route-progress';

export function AppLink({ children, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      {children}
      <LinkPendingSignal />
    </Link>
  );
}
