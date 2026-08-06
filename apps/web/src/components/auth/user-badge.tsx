import Image from 'next/image';

import type { SessionUser } from '@/lib/auth/session';

/** Compact identity chip shown at the bottom of the sidebar. */
export function UserBadge({ user }: { user: SessionUser }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5">
      {user.image != null ? (
        <Image
          src={user.image}
          alt=""
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-full"
        />
      ) : (
        <span
          aria-hidden
          className="bg-primary/20 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase"
        >
          {user.username.slice(0, 1)}
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{user.username}</p>
        {user.email != null && (
          <p className="text-muted-foreground truncate text-xs">{user.email}</p>
        )}
      </div>
    </div>
  );
}
