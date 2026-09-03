import {
  CardGridSkeleton,
  ListSkeleton,
  PageHeaderSkeleton,
} from '@/components/dashboard/skeletons';

/** Server detail: guild header + live player + settings + queue. */
export default function ServerDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={2} className="grid gap-4 lg:grid-cols-2" />
      <ListSkeleton rows={6} />
    </div>
  );
}
