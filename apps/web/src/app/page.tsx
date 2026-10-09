import { ListMusic, Music4, Radio, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { signIn } from '@/lib/auth';
import { getCurrentUser } from '@/lib/auth/session';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Landing page.
 *
 * Navigation reflects the server-verified session, not merely cookie presence.
 * Signed-out visitors can start Discord OAuth without an intermediate page.
 */

const FEATURES = [
  {
    icon: Music4,
    title: 'High-quality playback',
    description: 'Lavalink-powered audio from YouTube, Spotify, SoundCloud and Deezer.',
  },
  {
    icon: ListMusic,
    title: 'Queues and playlists',
    description: 'Build, reorder and save playlists from the dashboard or straight from Discord.',
  },
  {
    icon: Radio,
    title: 'Live control',
    description:
      'Skip, seek and adjust volume from the web, reflected in the voice channel instantly.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure by default',
    description: 'Discord OAuth2, per-guild permissions and rate-limited endpoints throughout.',
  },
] as const;

export default async function HomePage() {
  const user = await getCurrentUser();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col items-center justify-center gap-12 px-6 py-16">
      <header className="flex flex-col items-center gap-4 text-center">
        <span className="border-border bg-secondary text-secondary-foreground rounded-full border px-3 py-1 text-xs font-medium">
          Open beta
        </span>
        <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          Discord Music Platform
        </h1>
        <p className="text-muted-foreground max-w-2xl text-pretty text-lg">
          A production-grade Discord music bot with a full web dashboard. The monorepo, tooling and
          shared packages are in place — features arrive phase by phase.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          {user !== null ? (
            <Button size="lg" asChild>
              <Link href="/dashboard">Open dashboard</Link>
            </Button>
          ) : (
            <form
              action={async () => {
                'use server';
                await signIn('discord', { redirectTo: '/dashboard' });
              }}
            >
              <Button size="lg" type="submit">
                Continue with Discord
              </Button>
            </form>
          )}
          <Button size="lg" variant="outline" asChild>
            <a href="https://discord.js.org" target="_blank" rel="noreferrer noopener">
              Documentation
            </a>
          </Button>
        </div>
      </header>

      <section aria-label="Features" className="grid w-full gap-4 sm:grid-cols-2">
        {FEATURES.map(({ icon: Icon, title, description }) => (
          <Card key={title}>
            <CardHeader>
              <Icon aria-hidden className="text-primary size-5" />
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground text-sm">Coming soon.</CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
