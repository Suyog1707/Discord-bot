import {
  CardGridSkeleton,
  ListSkeleton,
  PageHeaderSkeleton,
} from '@/components/dashboard/skeletons';

/** Analytics: header + guild picker + stat cards + top-tracks list. */
export default function AnalyticsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={3} className="grid gap-4 sm:grid-cols-3" />
      <ListSkeleton rows={5} />
    </div>
  );
}
