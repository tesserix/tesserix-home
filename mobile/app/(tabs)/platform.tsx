import { ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Ticket, Megaphone, Activity, HeartPulse, Users, Database, Globe, Inbox, ShieldAlert, Trash2, ScrollText,
} from 'lucide-react-native';
import { ListRow, Screen, ScreenHeader, SectionLabel, Badge } from '../../components/kit';
import { space } from '../../lib/theme';
import { View } from 'react-native';

// Platform-wide ops. Live routes land on real screens; the rest are wired as the
// phased build reaches them (Phase 3).
const SECTIONS = [
  { group: 'Support', items: [
    { title: 'Platform tickets', sub: 'Cross-product support', icon: Ticket, route: '/platform/tickets', live: false },
    { title: 'Announcements', sub: 'Broadcast to products', icon: Megaphone, route: '/platform/announcements', live: false },
  ]},
  { group: 'Reliability', items: [
    { title: 'Service health', sub: 'Live status of services', icon: HeartPulse, route: '/platform/health', live: false },
    { title: 'Uptime', sub: 'SLA + incident history', icon: Activity, route: '/platform/uptime', live: false },
    { title: 'Observability', sub: 'Traces, logs, metrics', icon: Activity, route: '/platform/observability', live: false },
  ]},
  { group: 'Data & access', items: [
    { title: 'Users', sub: 'Cross-product directory', icon: Users, route: '/platform/users', live: false },
    { title: 'Databases', sub: 'Managed instances', icon: Database, route: '/platform/databases', live: false },
    { title: 'Custom domains', sub: 'DNS + verification', icon: Globe, route: '/platform/domains', live: false },
    { title: 'Outbox', sub: 'Event delivery', icon: Inbox, route: '/platform/outbox', live: false },
  ]},
  { group: 'Governance', items: [
    { title: 'Audit logs', sub: 'Every admin action', icon: ScrollText, route: '/platform/audit', live: false },
    { title: 'Erasure requests', sub: 'DPDP / GDPR queue', icon: Trash2, route: '/platform/erasure', live: false },
    { title: 'Break-glass', sub: 'Emergency access', icon: ShieldAlert, route: '/platform/break-glass', live: false },
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
