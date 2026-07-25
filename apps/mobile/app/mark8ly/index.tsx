// Mark8ly product hub. Live routes land on real screens; Slice-B items are "Soon".
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { LayoutDashboard, Users, Store, CreditCard, Route, ScrollText, Mail } from 'lucide-react-native';
import { ListRow, Screen, ScreenHeader, SectionLabel, Badge, BackButton } from '../../components/kit';
import { space } from '../../lib/theme';

const SECTIONS = [
  { group: 'Overview', items: [
    { title: 'Overview', sub: 'Revenue + business KPIs', icon: LayoutDashboard, route: '/mark8ly/overview', live: true },
  ]},
  { group: 'Growth', items: [
    { title: 'Leads', sub: 'CRM — status, notes, email', icon: Users, route: '/mark8ly/leads', live: true },
    { title: 'Onboarding', sub: 'Signup funnel', icon: Route, route: '/mark8ly/onboarding', live: false },
  ]},
  { group: 'Tenants & billing', items: [
    { title: 'Tenants', sub: 'Stores — status management', icon: Store, route: '/mark8ly/tenants', live: true },
    { title: 'Subscriptions', sub: 'Plans + MRR', icon: CreditCard, route: '/mark8ly/subscriptions', live: false },
  ]},
  { group: 'Ops', items: [
    { title: 'Audit logs', sub: 'Admin trail', icon: ScrollText, route: '/mark8ly/audit-logs', live: false },
    { title: 'Email templates', sub: 'Notification templates', icon: Mail, route: '/mark8ly/templates', live: false },
  ]},
] as const;

export default function Mark8lyHub() {
  return (
    <Screen>
      <ScreenHeader title="Mark8ly" subtitle="Marketplace SaaS" right={<BackButton onPress={() => router.back()} />} />
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
