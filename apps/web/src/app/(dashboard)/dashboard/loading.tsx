import { CardGridSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** Overview: welcome header + two stat cards + "jump back in". */
export default function DashboardOverviewLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={2} className="grid gap-4 sm:grid-cols-2" />
      <CardGridSkeleton count={3} />
    </div>
  );
}
