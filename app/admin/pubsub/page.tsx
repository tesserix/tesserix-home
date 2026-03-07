"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  MessageSquare,
  Search,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Radio,
  Webhook,
  Hash,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Skeleton,
  ErrorState,
  Stat,
  StatLabel,
  StatValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";
import type {
  PubSubResponse,
  TopicEntry,
  SubscriptionEntry,
} from "@/app/api/pubsub/route";

// ─── Helpers ───

function formatRetention(duration: string): string {
  // duration is like "604800s"
  const seconds = parseInt(duration.replace("s", ""), 10);
  if (isNaN(seconds)) return duration;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  return `${hours}h`;
}

// ─── Summary Cards ───

interface SummaryCardsProps {
  topics: TopicEntry[];
  subscriptions: SubscriptionEntry[];
}

function SummaryCards({ topics, subscriptions }: SummaryCardsProps) {
  const pushCount = subscriptions.filter((s) => s.type === "push").length;
  const pullCount = subscriptions.filter((s) => s.type === "pull").length;
  const dlqCount = subscriptions.filter((s) => s.hasDeadLetter).length;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat size="sm">
        <StatValue>{topics.length}</StatValue>
        <StatLabel>Topics</StatLabel>
      </Stat>
      <Stat size="sm">
        <StatValue>{subscriptions.length}</StatValue>
        <StatLabel>Subscriptions</StatLabel>
      </Stat>
      <Stat size="sm">
        <StatValue>
          <span className="text-blue-600">{pushCount}</span>
          <span className="text-muted-foreground mx-1">/</span>
          {pullCount}
        </StatValue>
        <StatLabel>Push vs Pull</StatLabel>
      </Stat>
      <Stat size="sm">
        <StatValue className={dlqCount > 0 ? "text-amber-600" : "text-muted-foreground"}>
          {dlqCount}
        </StatValue>
        <StatLabel>With Dead Letter</StatLabel>
      </Stat>
    </div>
  );
}

// ─── Topics Tab ───

interface TopicsTabProps {
  topics: TopicEntry[];
  loading: boolean;
}

function TopicsTab({ topics, loading }: TopicsTabProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return topics;
    const q = search.toLowerCase();
    return topics.filter((t) => t.name.toLowerCase().includes(q));
  }, [topics, search]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search topics..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <p className="text-sm text-muted-foreground ml-auto">
          {filtered.length} topic{filtered.length !== 1 ? "s" : ""}
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            {filtered.map((topic) => (
              <div
                key={topic.fullName}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="font-mono text-sm font-medium truncate">
                    {topic.name}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {topic.subscriptionCount > 0 ? (
                    <Badge
                      variant="secondary"
                      className="text-xs tabular-nums"
                    >
                      {topic.subscriptionCount}{" "}
                      {topic.subscriptionCount === 1 ? "sub" : "subs"}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-xs text-muted-foreground"
                    >
                      no subscribers
                    </Badge>
                  )}
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No topics found
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Subscriptions Tab ───

interface SubscriptionsTabProps {
  subscriptions: SubscriptionEntry[];
  loading: boolean;
}

function SubscriptionsTab({ subscriptions, loading }: SubscriptionsTabProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return subscriptions;
    const q = search.toLowerCase();
    return subscriptions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.topic.toLowerCase().includes(q)
    );
  }, [subscriptions, search]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search subscriptions or topics..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <p className="text-sm text-muted-foreground ml-auto">
          {filtered.length} subscription{filtered.length !== 1 ? "s" : ""}
        </p>
      </div>

      <div className="space-y-3">
        {filtered.map((sub) => (
          <Card key={sub.fullName}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                {/* Name + topic */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {sub.type === "push" ? (
                      <Webhook className="h-4 w-4 shrink-0 text-blue-500" />
                    ) : (
                      <Radio className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <p className="font-mono text-sm font-medium truncate">
                      {sub.name}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 ml-6">
                    <p className="text-xs text-muted-foreground">topic:</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {sub.topic}
                    </p>
                  </div>
                  {sub.pushEndpoint && (
                    <div className="flex items-center gap-1.5 mt-0.5 ml-6">
                      <p className="text-xs text-muted-foreground">endpoint:</p>
                      <p className="font-mono text-xs text-muted-foreground truncate max-w-xs">
                        {sub.pushEndpoint}
                      </p>
                    </div>
                  )}
                </div>

                {/* Badges */}
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {sub.type === "push" ? (
                    <Badge variant="info" className="gap-1">
                      <Webhook className="h-3 w-3" />
                      push
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1">
                      <Radio className="h-3 w-3" />
                      pull
                    </Badge>
                  )}
                  {sub.hasDeadLetter && (
                    <Badge variant="warning" className="gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      DLQ
                    </Badge>
                  )}
                </div>
              </div>

              {/* Metadata row */}
              <div className="mt-3 flex items-center gap-4 flex-wrap ml-6">
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {sub.ackDeadlineSeconds}s
                  </span>{" "}
                  ack deadline
                </div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {formatRetention(sub.messageRetentionDuration)}
                  </span>{" "}
                  retention
                </div>
                {sub.hasDeadLetter && sub.deadLetterTopic && (
                  <div className="text-xs text-muted-foreground">
                    DLQ:{" "}
                    <span className="font-mono font-medium text-foreground">
                      {sub.deadLetterTopic}
                    </span>
                    {sub.maxDeliveryAttempts !== undefined && (
                      <span className="ml-1">
                        (max {sub.maxDeliveryAttempts} attempts)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}

        {filtered.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No subscriptions found
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ───

export default function PubSubPage() {
  const [data, setData] = useState<PubSubResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<{ data: PubSubResponse }>("/api/pubsub");
    if (res.error) {
      setError(
        typeof res.error === "string" ? res.error : "Failed to fetch Pub/Sub data"
      );
    } else if (res.data?.data) {
      setData(res.data.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <>
      <AdminHeader
        title="Pub/Sub"
        description="GCP Pub/Sub topics and subscriptions"
        icon={<MessageSquare className="h-5 w-5 text-muted-foreground" />}
      />

      <div className="p-6 space-y-6">
        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            Refresh
          </Button>
        </div>

        {/* Summary */}
        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : data ? (
          <SummaryCards
            topics={data.topics}
            subscriptions={data.subscriptions}
          />
        ) : null}

        {/* Error */}
        {error && (
          <ErrorState message={error} onRetry={fetchData} />
        )}

        {/* Tabs */}
        <Tabs defaultValue="topics" className="space-y-4">
          <TabsList>
            <TabsTrigger value="topics" className="gap-2">
              <Hash className="h-4 w-4" />
              Topics
              {data && !loading && (
                <Badge variant="secondary" className="ml-1 text-xs">
                  {data.topics.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="subscriptions" className="gap-2">
              <Radio className="h-4 w-4" />
              Subscriptions
              {data && !loading && (
                <Badge variant="secondary" className="ml-1 text-xs">
                  {data.subscriptions.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="topics">
            <TopicsTab
              topics={data?.topics ?? []}
              loading={loading}
            />
          </TabsContent>

          <TabsContent value="subscriptions">
            <SubscriptionsTab
              subscriptions={data?.subscriptions ?? []}
              loading={loading}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
