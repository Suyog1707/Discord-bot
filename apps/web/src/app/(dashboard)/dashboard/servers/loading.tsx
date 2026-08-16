import { CardGridSkeleton, PageHeaderSkeleton } from '@/components/dashboard/skeletons';

/** Servers: header + the guild card grid. */
export default function ServersLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton wide />
      <CardGridSkeleton count={6} />
    </div>
  );
}
