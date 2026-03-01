import { Skeleton } from "@/components/ui/skeleton";

interface TableSkeletonProps {
  columns: number;
  rows?: number;
}

export function TableSkeleton({ columns, rows = 5 }: TableSkeletonProps) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="p-4 space-y-4">
        {/* Header row */}
        <div className="flex gap-4">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {/* Data rows */}
        {Array.from({ length: rows }).map((_, row) => (
          <div key={row} className="flex gap-4 items-center">
            {Array.from({ length: columns }).map((_, col) => (
              <Skeleton key={col} className="h-5 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
