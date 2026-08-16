/**
 * Shared loading skeletons for the dashboard routes.
 *
 * Every dashboard page is `force-dynamic` and awaits Discord/Postgres before
 * it can render, so without a loading boundary a click leaves the old page on
 * screen until the server finishes — the navigation reads as "frozen". These
 * shapes mirror each page's real layout so the swap-in is not a jolt, and
 * their presence is also what lets `<Link>` prefetch dynamic routes at all.
 */
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Title + description block that every dashboard page starts with. */
export function PageHeaderSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className={wide ? 'h-4 w-full max-w-xl' : 'h-4 w-72'} />
    </div>
  );
}

/** Grid of cards — servers, overview stats, playlists. */
export function CardGridSkeleton({
  count = 6,
  className = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3',
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={className}>
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} className="gap-4">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Stacked rows inside a single card — favorites, sessions, queue. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-10 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-8 w-20 shrink-0" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
