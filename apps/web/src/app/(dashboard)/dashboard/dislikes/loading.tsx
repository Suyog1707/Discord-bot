import { ListSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** Not like: header + rejected-track rows. */
export default function DislikesLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton wide />
      <ListSkeleton rows={6} />
    </div>
  );
}
