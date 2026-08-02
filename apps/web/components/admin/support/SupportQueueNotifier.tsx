"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOttoChannel, type Conversation, type WsEnvelope } from "@tesserix/otto-widget";
import { useToast } from "@tesserix/web";

// Live staff-queue awareness for the whole admin console. Subscribes to the
// cross-tenant platform inbox WebSocket (same channel the live-chat page
// uses) so a chat entering the queue surfaces within seconds anywhere in the
// admin — a toast linking to the inbox plus a badge count on the sidebar —
// instead of only when someone happens to have the live-chat page open. The
// durable follow-up (email nudges while a chat sits unaccepted) runs
// server-side via NATS + Temporal in homechef-api; this is the in-console
// real-time layer on top.

const LIVE_CHAT_PATH = "/admin/support/live-chat";

const SupportQueueContext = createContext<number>(0);

// needs_human is on otto's wire payload but not yet in the published
// @tesserix/otto-widget Conversation type (0.6.0).
type QueueConversation = Conversation & { needs_human?: boolean };

/** Pending (waiting-for-a-human) conversation count across all tenants. */
export function useSupportQueueCount(): number {
  return useContext(SupportQueueContext);
}

function inboxWsUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/platform/otto/ws`;
}

export function SupportQueueProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const pathname = usePathname();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // Toasting is suppressed on the live-chat page itself (the inbox is the
  // notification there) — tracked via ref so the WS handler stays stable.
  const onLiveChatRef = useRef(false);
  onLiveChatRef.current = pathname?.startsWith(LIVE_CHAT_PATH) ?? false;
  // Escalation toasts can repeat per conversation (each handoff matters),
  // but a reconnect snapshot must not re-toast everything already seen.
  const seenRef = useRef<Set<string>>(new Set());

  const announce = useCallback(
    (conv: Conversation, escalated: boolean) => {
      if (onLiveChatRef.current) return;
      const who = conv.customer?.name || conv.customer?.email || "A user";
      toast({
        title: escalated ? "Otto handed a chat to the team" : "New support chat waiting",
        description: (
          <span>
            {who}
            {conv.tenant_id ? ` · ${conv.tenant_id}` : ""}
            {conv.case_id ? ` · ${conv.case_id}` : ""}{" "}
            <Link href={LIVE_CHAT_PATH} className="font-medium underline underline-offset-2">
              Open live chat
            </Link>
          </span>
        ),
      });
    },
    [toast],
  );

  const apply = useCallback(
    (conv: QueueConversation, live: boolean) => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        if (conv.status === "pending") next.add(conv.id);
        else next.delete(conv.id);
        return next;
      });
      if (!live || conv.status !== "pending") return;
      const escalated = Boolean(conv.needs_human);
      const key = `${conv.id}:${escalated ? conv.updated_at : "new"}`;
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      announce(conv, escalated);
    },
    [announce],
  );

  // Seed (and re-seed on every reconnect — the WS has no replay) from the
  // pending list, without toasting what was already waiting.
  const snapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/otto/conversations?status=pending", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      const rows: QueueConversation[] = Array.isArray(data) ? data : (data.conversations ?? []);
      setPendingIds(new Set(rows.map((r) => r.id)));
      for (const r of rows) {
        seenRef.current.add(`${r.id}:new`);
        if (r.needs_human) seenRef.current.add(`${r.id}:${r.updated_at}`);
      }
    } catch {
      // Snapshot is best-effort; the socket keeps the count converging.
    }
  }, []);

  const onEvent = useCallback(
    (env: WsEnvelope) => {
      if (
        env.type !== "otto.conversation.created" &&
        env.type !== "otto.conversation.updated" &&
        env.type !== "otto.conversation.closed"
      ) {
        return;
      }
      const conv = (env.payload as { conversation?: QueueConversation })?.conversation;
      if (!conv?.id) return;
      apply(conv, true);
    },
    [apply],
  );

  useOttoChannel({
    url: inboxWsUrl(),
    ticketUrl: "/api/admin/otto/ws-ticket",
    onEvent,
    onOpen: snapshot,
  });

  useEffect(() => {
    void snapshot();
  }, [snapshot]);

  const count = useMemo(() => pendingIds.size, [pendingIds]);
  return <SupportQueueContext.Provider value={count}>{children}</SupportQueueContext.Provider>;
}
