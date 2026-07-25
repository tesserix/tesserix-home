import Link from "next/link";
import { MessageSquare, Ticket } from "lucide-react";
import { Button } from "@tesserix/web";

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
      <div className="flex items-center justify-end border-b border-border px-6 py-3">
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/platform-tickets">
            <Ticket className="mr-2 h-4 w-4" />
            Create support ticket
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-6">
        <PlatformLiveChatInbox currentUserId={session?.sub ?? ""} />
      </div>
    </div>
  );
}
