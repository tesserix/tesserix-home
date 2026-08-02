import Link from "next/link";
import { MessageSquare, Ticket } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { PlatformLiveChatInbox } from "@/components/admin/support/PlatformLiveChatInbox";

// Platform support inbox — Tesserix staff answer customer chats from EVERY
// product (homechef, fanzone, platform, …) in one queue. The customer-side
// bubble was removed from the admin layout (spec decision 2): admin is a
// staff-side surface only.
//
// Ticket escalation (spec decision 3) is a v1 affordance: OttoInbox@0.6.0
// exposes no selected-conversation state and the tickets system has no
// admin create route (creation is product-side, /api/internal, and
// platform_tickets.tenant_id is a UUID column incompatible with otto's
// product-slug tenants). So the "Create support ticket" button links to the
// tickets console; staff copy context from the open thread. True one-click
// prefilled escalation is deferred to Phase 4 (needs a widget selection prop
// + a tickets tenant-model change).
export default async function LiveChatPage() {
  const session = await getCurrentSession().catch(() => null);
  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Live chat"
        description="Real-time support conversations across every Tesserix product."
        icon={<MessageSquare className="h-6 w-6 text-muted-foreground" />}
      />
      {/* A plain styled Link, not the design-system Button: this page is a
          server component, and @tesserix/web is in optimizePackageImports —
          importing a client component through that rewritten barrel breaks
          the client reference, so it hydrates as undefined (React #130). */}
      <div className="flex items-center justify-end border-b border-border px-6 py-3">
        <Link
          href="/admin/platform-tickets"
          className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Ticket className="mr-2 h-4 w-4" />
          Create support ticket
        </Link>
      </div>
      <div className="min-h-0 flex-1 p-6">
        <PlatformLiveChatInbox currentUserId={session?.sub ?? ""} />
      </div>
    </div>
  );
}
