import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getAccessToken,
  gcpApi,
  GCP_PROJECT,
} from "@/lib/api/gcp";

// ─── GCP API Types ───

interface GCPTopic {
  name: string; // projects/{project}/topics/{name}
}

interface GCPTopicsResponse {
  topics?: GCPTopic[];
  nextPageToken?: string;
}

interface PushConfig {
  pushEndpoint?: string;
  oidcToken?: {
    serviceAccountEmail?: string;
    audience?: string;
  };
}

interface DeadLetterPolicy {
  deadLetterTopic?: string;
  maxDeliveryAttempts?: number;
}

interface GCPSubscription {
  name: string; // projects/{project}/subscriptions/{name}
  topic: string; // projects/{project}/topics/{name}
  pushConfig?: PushConfig;
  ackDeadlineSeconds?: number;
  messageRetentionDuration?: string;
  deadLetterPolicy?: DeadLetterPolicy;
  state?: string;
}

interface GCPSubscriptionsResponse {
  subscriptions?: GCPSubscription[];
  nextPageToken?: string;
}

// ─── Response Types ───

export interface TopicEntry {
  name: string; // short name
  fullName: string;
  subscriptionCount: number;
}

export interface SubscriptionEntry {
  name: string; // short name
  fullName: string;
  topic: string; // short topic name
  topicFull: string;
  type: "push" | "pull";
  pushEndpoint?: string;
  ackDeadlineSeconds: number;
  messageRetentionDuration: string;
  hasDeadLetter: boolean;
  deadLetterTopic?: string;
  maxDeliveryAttempts?: number;
}

export interface PubSubResponse {
  topics: TopicEntry[];
  subscriptions: SubscriptionEntry[];
}

// ─── Helpers ───

function shortName(fullResourceName: string): string {
  const parts = fullResourceName.split("/");
  return parts[parts.length - 1];
}

// ─── Handler ───

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = await getAccessToken();

    // Fetch topics and subscriptions in parallel
    const [topicsResponse, subsResponse] = await Promise.all([
      gcpApi<GCPTopicsResponse>(
        `pubsub.googleapis.com/v1/projects/${GCP_PROJECT}/topics`,
        token
      ),
      gcpApi<GCPSubscriptionsResponse>(
        `pubsub.googleapis.com/v1/projects/${GCP_PROJECT}/subscriptions`,
        token
      ),
    ]);

    const rawTopics = topicsResponse.topics ?? [];
    const rawSubs = subsResponse.subscriptions ?? [];

    // Count subscriptions per topic
    const subCountByTopic = new Map<string, number>();
    for (const sub of rawSubs) {
      const count = subCountByTopic.get(sub.topic) ?? 0;
      subCountByTopic.set(sub.topic, count + 1);
    }

    const topics: TopicEntry[] = rawTopics.map((t) => ({
      name: shortName(t.name),
      fullName: t.name,
      subscriptionCount: subCountByTopic.get(t.name) ?? 0,
    }));

    const subscriptions: SubscriptionEntry[] = rawSubs.map((sub) => {
      const isPush =
        !!sub.pushConfig?.pushEndpoint &&
        sub.pushConfig.pushEndpoint.trim() !== "";
      return {
        name: shortName(sub.name),
        fullName: sub.name,
        topic: shortName(sub.topic),
        topicFull: sub.topic,
        type: isPush ? "push" : "pull",
        pushEndpoint: sub.pushConfig?.pushEndpoint,
        ackDeadlineSeconds: sub.ackDeadlineSeconds ?? 10,
        messageRetentionDuration: sub.messageRetentionDuration ?? "604800s",
        hasDeadLetter: !!sub.deadLetterPolicy?.deadLetterTopic,
        deadLetterTopic: sub.deadLetterPolicy?.deadLetterTopic
          ? shortName(sub.deadLetterPolicy.deadLetterTopic)
          : undefined,
        maxDeliveryAttempts: sub.deadLetterPolicy?.maxDeliveryAttempts,
      };
    });

    const response: PubSubResponse = { topics, subscriptions };
    return NextResponse.json({ data: response });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch Pub/Sub data";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
