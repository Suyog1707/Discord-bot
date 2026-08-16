import { CardGridSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** Playlists: header + create form + playlist grid. */
export default function PlaylistsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton wide />
      <CardGridSkeleton count={1} className="grid gap-4" />
      <CardGridSkeleton count={6} />
    </div>
  );
}
