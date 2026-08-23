import { ListSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** History: header + listened-track rows. */
export default function HistoryLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton wide />
      <ListSkeleton rows={8} />
    </div>
  );
}
