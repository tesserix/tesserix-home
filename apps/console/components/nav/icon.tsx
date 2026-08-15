import {
  Activity, BarChart3, Cloud, Database, Gauge, Globe, HeartPulse, Inbox,
  KeyRound, LayoutDashboard, LifeBuoy, Mail, Megaphone, MessageSquare,
  ScrollText, Settings, Shield, Users,
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
  "cloud": Cloud,
  "life-buoy": LifeBuoy,
  "bar-chart": BarChart3,
  "megaphone": Megaphone,
  "heart-pulse": HeartPulse,
  "gauge": Gauge,
  "globe": Globe,
  "mail": Mail,
  "shield": Shield,
  "key-round": KeyRound,
  "users": Users,
};

export function NavIcon({ name, className }: { name: IconKey; className?: string }) {
  const Cmp = REGISTRY[name];
  return <Cmp className={className} aria-hidden="true" />;
}
