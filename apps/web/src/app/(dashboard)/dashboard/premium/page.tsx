import { Check } from 'lucide-react';
import type { Metadata } from 'next';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { getProfile } from '@/lib/services/account';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Premium' };
export const dynamic = 'force-dynamic';

const TIERS = [
  {
    name: 'Free',
    tier: 'FREE',
    price: '$0',
    features: ['Unlimited playback', '25 playlists', 'Standard audio quality', 'Community support'],
  },
  {
    name: 'Plus',
    tier: 'PLUS',
    price: '$3.99/mo',
    features: [
      'Everything in Free',
      '250 playlists',
      'Volume boost up to 200%',
      'Priority queue persistence',
    ],
  },
  {
    name: 'Pro',
    tier: 'PRO',
    price: '$7.99/mo',
    features: [
      'Everything in Plus',
      '24/7 playback mode',
      'Audio filters (coming soon)',
      'Priority support',
    ],
  },
] as const;

export default async function PremiumPage() {
  const user = await requireUserOrRedirect('/dashboard/premium');
  const profile = await getProfile(user.id);
  const currentTier = profile.premium.tier;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Premium</h1>
        <p className="text-muted-foreground">
          You are on the <Badge variant="secondary">{currentTier}</Badge> tier.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {TIERS.map((tier) => {
          const isCurrent = tier.tier === currentTier;
          return (
            <Card key={tier.tier} className={isCurrent ? 'border-primary' : undefined}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  {tier.name}
                  {isCurrent && <Badge>Current</Badge>}
                </CardTitle>
                <CardDescription className="text-xl font-semibold">{tier.price}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <ul className="flex flex-col gap-2 text-sm">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check aria-hidden className="text-success mt-0.5 size-4 shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-auto"
                  variant={isCurrent ? 'outline' : 'default'}
                  disabled
                  title="Billing integration is not yet connected"
                >
                  {isCurrent ? 'Current plan' : 'Coming soon'}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-muted-foreground text-xs">
        Billing is not yet connected — plans are shown for preview. No payment details are
        collected.
      </p>
    </div>
  );
}
