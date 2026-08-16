import { ListSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** Favorites: header + saved-track rows. */
export default function FavoritesLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton wide />
      <ListSkeleton rows={6} />
    </div>
  );
}
