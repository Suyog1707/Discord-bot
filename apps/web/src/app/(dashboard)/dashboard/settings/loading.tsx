import { CardGridSkeleton, ListSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** Settings: header + profile card + Spotify card + active sessions. */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={2} className="grid gap-4 sm:grid-cols-2" />
      <ListSkeleton rows={4} />
    </div>
  );
}
