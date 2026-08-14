import {
  Activity, Database, Inbox, LayoutDashboard, MessageSquare,
  ScrollText, Settings, Users,
} from "lucide-react";
import type { IconKey } from "@tesserix/console-core";

const REGISTRY: Record<IconKey, React.ComponentType<{ className?: string }>> = {
  "activity": Activity,
  "database": Database,
  "inbox": Inbox,
  "layout-dashboard": LayoutDashboard,
  "message-square": MessageSquare,
  "scroll-text": ScrollText,
  "settings": Settings,
  "users": Users,
};

export function NavIcon({ name, className }: { name: IconKey; className?: string }) {
  const Cmp = REGISTRY[name];
  return <Cmp className={className} aria-hidden="true" />;
}
