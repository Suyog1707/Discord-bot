'use client';

import { useRef, useState, type ReactNode } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';

/** Use the stable, CSRF-protected auth API instead of build-specific Server Actions. */
export function DiscordSignInButton({
  redirectTo,
  className,
  children,
}: {
  redirectTo: string;
  className?: string;
  children: ReactNode;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function connect() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await signIn('discord', { redirectTo });
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div>
      <Button
        size="lg"
        type="button"
        className={className}
        disabled={busy}
        onClick={() => {
          void connect();
        }}
      >
        {busy ? 'Connecting to Discord…' : children}
      </Button>
      {failed && <p role="alert">Could not start Discord sign-in. Please try again.</p>}
    </div>
  );
}
