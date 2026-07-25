import { ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Ticket, Megaphone, Activity, HeartPulse, Users, Database, Globe, Inbox, ShieldAlert, Trash2, ScrollText, BarChart3, Mail, FileText,
} from 'lucide-react-native';
import { ListRow, Screen, ScreenHeader, SectionLabel, Badge } from '../../components/kit';
import { space } from '../../lib/theme';
import { View } from 'react-native';

// Platform-wide ops. Live routes land on real screens. Audit logs stays queued —
// it's per-product (each app exposes its own audit trail), not a platform-wide feed.
const SECTIONS = [
  { group: 'Support', items: [
    { title: 'Platform tickets', sub: 'Cross-product support', icon: Ticket, route: '/platform/tickets', live: true },
    { title: 'Announcements', sub: 'Broadcast to products', icon: Megaphone, route: '/platform/announcements', live: true },
    { title: 'Support analytics', sub: 'Otto support rollup', icon: BarChart3, route: '/platform/analytics-support', live: true },
  ]},
  { group: 'Notifications', items: [
    { title: 'Notifications log', sub: 'Email delivery + events', icon: Mail, route: '/platform/notifications-log', live: true },
    { title: 'Lead templates', sub: 'Marketing emails + test send', icon: FileText, route: '/platform/lead-templates', live: true },
  ]},
  { group: 'Reliability', items: [
    { title: 'Service health', sub: 'Live status of workloads', icon: HeartPulse, route: '/platform/health', live: true },
    { title: 'Uptime', sub: 'Tenant endpoint probes', icon: Activity, route: '/platform/uptime', live: true },
    { title: 'Observability', sub: 'Traces across products', icon: Activity, route: '/platform/observability', live: true },
  ]},
  { group: 'Data & access', items: [
    { title: 'Users', sub: 'Cross-product directory', icon: Users, route: '/platform/users', live: true },
    { title: 'Databases', sub: 'CloudNativePG clusters', icon: Database, route: '/platform/databases', live: true },
    { title: 'Custom domains', sub: 'DNS + verification', icon: Globe, route: '/platform/domains', live: true },
    { title: 'Outbox', sub: 'Event delivery', icon: Inbox, route: '/platform/outbox', live: true },
  ]},
  { group: 'Governance', items: [
    { title: 'Erasure requests', sub: 'DPDP / GDPR queue', icon: Trash2, route: '/platform/erasure', live: true },
    { title: 'Break-glass', sub: 'Emergency access', icon: ShieldAlert, route: '/platform/break-glass', live: true },
    { title: 'Audit logs', sub: 'Per-product admin trail', icon: ScrollText, route: '/platform/audit', live: false },
  ]},
] as const;

export default function Platform() {
  const router = useRouter();
  return (
    <Screen>
      <ScreenHeader title="Platform" subtitle="Company-wide operations" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10] }}>
        {SECTIONS.map((sec) => (
          <View key={sec.group} style={{ marginTop: space[4] }}>
            <SectionLabel>{sec.group}</SectionLabel>
            <View style={{ gap: 8 }}>
              {sec.items.map((it) => (
                <ListRow
                  key={it.title}
                  title={it.title}
                  subtitle={it.sub}
                  icon={it.icon}
                  trailing={it.live ? undefined : <Badge label="Soon" tone="neutral" />}
                  onPress={it.live ? () => router.push(it.route as never) : undefined}
                />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
