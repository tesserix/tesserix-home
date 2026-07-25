// Identity — every exact-match record for one email, grouped by source. Read-only:
// the web admin owns the deep-links, so this view just surfaces where the person exists.

import { ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useUserDetail } from '../../../lib/platform-hooks';
import { titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  Banner,
  EmptyState,
  ListRow,
  LoadingRows,
  Screen,
  ScreenHeader,
  SectionLabel,
  BackButton,
} from '../../../components/kit';
import { usePalette, space } from '../../../lib/theme';

const SOURCE_LABELS: Record<string, string> = {
  tenants: 'Tenants',
  customers: 'Storefront customers',
  leads: 'Leads',
  mark8ly_users: 'Mark8ly accounts',
  invitations: 'Pending invites',
  platform_tickets: 'Platform tickets',
  merchant_tickets: 'Customer tickets',
  onboarding: 'Onboarding sessions',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? titleCase(source);
}

export default function UserDetail() {
  const p = usePalette();
  const { email } = useLocalSearchParams<{ email: string }>();
  const q = useUserDetail(email ?? '');
  const data = q.data;
  const grouped = data?.grouped ?? {};
  const sources = Object.keys(grouped);

  return (
    <Screen>
      <ScreenHeader
        title="Identity"
        subtitle={email}
        right={<BackButton onPress={() => router.back()} />}
      />

      {q.isLoading ? (
        <LoadingRows />
      ) : !data || data.totalMatches === 0 ? (
        <EmptyState title="No exact-match identities" body="No records matched this email." />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: space[10] }}>
          {data.failures.length ? (
            <Banner text="Partial — some sources unavailable" tone="warning" />
          ) : null}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[3] }}
          >
            {sources.map((source) => (
              <Badge key={source} label={`${sourceLabel(source)} · ${(grouped[source] ?? []).length}`} />
            ))}
          </ScrollView>

          {sources.map((source) => (
            <View key={source} style={{ paddingHorizontal: space[4], paddingTop: space[2] }}>
              <SectionLabel>{sourceLabel(source)}</SectionLabel>
              <View style={{ gap: 8 }}>
                {(grouped[source] ?? []).map((r, i) => (
                  <ListRow
                    key={`${source}-${i}`}
                    title={r.label}
                    subtitle={r.sublabel ? `${r.email} · ${r.sublabel}` : r.email}
                    trailing={<Badge label={r.kind} />}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
