import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { DiscordSignInButton } from '@/components/discord-sign-in-button';
import { getCurrentUser } from '@/lib/auth/session';
import { safeCallbackUrl } from '@/lib/safe-redirect';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Sign in' };

/** Human messages for Auth.js error codes surfaced via ?error=. */
const ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    'That Discord account is already linked to a different sign-in. Use the account you signed up with.',
  AccessDenied: 'Sign-in was cancelled or denied. Try again when you are ready.',
  Configuration: 'Sign-in is misconfigured on our side. Please try again later.',
  Verification: 'The sign-in link is no longer valid. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; reauth?: string }>;
}) {
  const params = await searchParams;
  const requested = safeCallbackUrl(params.callbackUrl);
  // A stale callback pointing back to login must not create a redirect loop
  // for a valid session. Authentication endpoints are not landing pages.
  const pathname = new URL(requested, 'https://internal.invalid').pathname;
  const callbackUrl =
    pathname.replace(/\/+$/u, '') === '/login' || pathname.startsWith('/api/auth')
      ? '/dashboard'
      : requested;
  /**
   * Sent here by `withDiscordLink`: the visitor is still signed in to *this*
   * app, but the Discord authorization behind it is dead. Skipping the
   * shortcut below is what makes that recoverable — bouncing them back to the
   * page that just failed would only loop.
   */
  const reauth = params.reauth === '1';

  // Already signed in? Straight through — unless they are here to reconnect.
  if (!reauth && (await getCurrentUser()) !== null) {
    redirect(callbackUrl);
  }

  const errorMessage =
    params.error === undefined
      ? undefined
      : (ERROR_MESSAGES[params.error] ?? 'Something went wrong during sign-in. Please try again.');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-6">
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            {reauth ? 'Reconnect Discord' : 'Welcome back'}
          </CardTitle>
          <CardDescription>
            {reauth
              ? 'Your Discord connection expired, so we cannot read your server list. Reconnect to pick up where you left off.'
              : 'Sign in with Discord to manage your servers, queues and playlists.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errorMessage !== undefined && (
            <p
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
            >
              {errorMessage}
            </p>
          )}
          <DiscordSignInButton redirectTo={callbackUrl} className="w-full">
            <svg viewBox="0 0 24 24" aria-hidden className="size-5 fill-current">
              <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
            {reauth ? 'Reconnect with Discord' : 'Continue with Discord'}
          </DiscordSignInButton>
          <p className="text-muted-foreground text-center text-xs">
            We request your identity, email and server list — never your password or messages.
          </p>
        </CardContent>
      </Card>
      <Button variant="ghost" size="sm" asChild>
        <Link href="/">← Back to home</Link>
      </Button>
    </main>
  );
}
