import { LogOut } from 'lucide-react';

import { signOut } from '@/lib/auth';
import { Button } from '@/components/ui/button';

/**
 * Sign-out as a server-action form: works without client JS and keeps the
 * session invalidation on the server where the database session lives.
 */
export function SignOutButton() {
  return (
    <form
      action={async () => {
        'use server';
        await signOut({ redirectTo: '/' });
      }}
    >
      <Button type="submit" variant="ghost" size="sm">
        <LogOut aria-hidden />
        Sign out
      </Button>
    </form>
  );
}
