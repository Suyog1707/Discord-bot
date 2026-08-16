import { ListSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** Playlist detail: header + track rows. */
export default function PlaylistDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <ListSkeleton rows={8} />
    </div>
  );
}
