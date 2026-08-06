'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Route-segment error boundary.
 *
 * Next.js strips the real message in production and replaces it with a digest,
 * so the UI shows a generic message and surfaces the digest for support to
 * correlate against server logs.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client-side reporting hook; replaced by a real error sink in a later phase.
    console.error('Unhandled UI error:', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">
        An unexpected error occurred. Please try again — if it keeps happening, contact support.
      </p>
      {error.digest !== undefined && (
        <p className="text-muted-foreground font-mono text-xs">Reference: {error.digest}</p>
      )}
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
