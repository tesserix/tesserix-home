"use client";

import {
  Rocket,
  Undo2,
  Lock,
  Unlock,
  ExternalLink,
} from "lucide-react";
import {
  useReleaseHistory,
  type ReleaseAction,
  type ReleaseEvent,
} from "@/lib/api/releases";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
} from "@tesserix/web";

const ACTION_CONFIG: Record<
  ReleaseAction,
  { icon: typeof Rocket; color: string; borderColor: string; label: string }
> = {
  promote: {
    icon: Rocket,
    color: "text-green-500",
    borderColor: "border-l-green-500",
    label: "Promoted",
  },
  rollback: {
    icon: Undo2,
    color: "text-blue-400",
    borderColor: "border-l-blue-400",
    label: "Rolled back",
  },
  lock: {
    icon: Lock,
    color: "text-amber-400",
    borderColor: "border-l-amber-400",
    label: "Locked",
  },
  unlock: {
    icon: Unlock,
    color: "text-amber-400",
    borderColor: "border-l-amber-400",
    label: "Unlocked",
  },
};

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function groupByDay(events: ReleaseEvent[]): Map<string, ReleaseEvent[]> {
  const groups = new Map<string, ReleaseEvent[]>();
  for (const event of events) {
    const day = new Date(event.timestamp).toDateString();
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(event);
  }
  return groups;
}

function HistoryEntry({ event }: { event: ReleaseEvent }) {
  const config = ACTION_CONFIG[event.action];
  const Icon = config.icon;

  return (
    <div
      className={`flex items-start gap-3 py-3 px-4 border-l-2 ${config.borderColor} hover:bg-muted/30 transition-colors rounded-r-lg`}
    >
      <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${config.color}`} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-medium ${config.color}`}>
            {config.label}
          </span>
          <span className="text-sm font-medium">
            {event.serviceDisplayName}
          </span>
          {event.toVersion && (
            <Badge variant="outline" className="font-mono text-xs">
              v{event.toVersion}
            </Badge>
          )}
          {event.fromVersion && event.toVersion && (
            <>
              <span className="text-xs text-muted-foreground">from</span>
              <Badge variant="secondary" className="font-mono text-xs">
                v{event.fromVersion}
              </Badge>
            </>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
          <span>{formatTime(event.timestamp)}</span>
          <span>by {event.triggeredBy}</span>
          {event.pipelineUrl && (
            <a
              href={event.pipelineUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Pipeline
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function HistoryTabSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}

export function HistoryTab() {
  const { data, isLoading, error, mutate } = useReleaseHistory();

  if (isLoading) return <HistoryTabSkeleton />;

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">{error}</p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={mutate}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const events = data?.data ?? [];

  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-2">
          <Rocket className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">No release events yet.</p>
          <p className="text-xs text-muted-foreground">
            Promotion, rollback, and lock events will appear here.
          </p>
        </CardContent>
      </Card>
    );
  }

  const dayGroups = groupByDay(events);

  return (
    <div className="space-y-6">
      {Array.from(dayGroups.entries()).map(([day, dayEvents]) => (
        <div key={day}>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">
            {formatDate(dayEvents[0].timestamp)}
          </h3>
          <div className="space-y-1">
            {dayEvents.map((event) => (
              <HistoryEntry key={event.id} event={event} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
