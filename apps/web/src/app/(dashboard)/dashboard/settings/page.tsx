import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { formString } from '@/lib/forms';
import {
  getProfile,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from '@/lib/services/account';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

async function sessionTokenFromCookies(): Promise<string | null> {
  const store = await cookies();
  return (
    store.get('__Secure-authjs.session-token')?.value ??
    store.get('authjs.session-token')?.value ??
    null
  );
}

export default async function AccountSettingsPage() {
  const user = await requireUserOrRedirect('/dashboard/settings');
  const [profile, sessions] = await Promise.all([
    getProfile(user.id),
    sessionTokenFromCookies().then((token) => listSessions(user.id, token)),
  ]);

  async function revokeOne(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/settings');
    await revokeSession(actor.id, formString(formData, 'sessionId'));
    revalidatePath('/dashboard/settings');
  }

  async function revokeOthers() {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/settings');
    await revokeOtherSessions(actor.id, await sessionTokenFromCookies());
    revalidatePath('/dashboard/settings');
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account settings</h1>
        <p className="text-muted-foreground">Your profile and active sessions.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Synced from Discord at each sign-in.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground text-xs">Username</p>
            <p className="font-medium">{profile.globalName ?? profile.username}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Email</p>
            <p className="font-medium">{profile.email ?? '—'}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Discord ID</p>
            <p className="font-mono text-xs">{profile.discordId}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Member since</p>
            <p className="font-medium">{profile.createdAt.toLocaleDateString()}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Signed-in devices. Revoke anything you do not recognise.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="border-border flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {session.userAgent ?? 'Unknown device'}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {session.ipAddress ?? 'Unknown IP'} · signed in{' '}
                    {session.createdAt.toLocaleString()}
                  </span>
                </span>
                {session.current ? (
                  <Badge variant="success">This device</Badge>
                ) : (
                  <form action={revokeOne}>
                    <input type="hidden" name="sessionId" value={session.id} />
                    <Button type="submit" size="sm" variant="outline">
                      Revoke
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>

          {sessions.some((session) => !session.current) && (
            <form action={revokeOthers}>
              <Button type="submit" variant="destructive" size="sm">
                Sign out all other devices
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
