// Users — cross-product identity search. Type an email (3+ chars) to find people
// across every product; results group by source and deep-link to the identity view.

import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useUserSearch } from '../../lib/platform-hooks';
import type { UserSearchResult } from '../../lib/platform-contracts';
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
  SearchField,
  BackButton,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

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

export default function Users() {
  const p = usePalette();
  const [query, setQuery] = useState('');
  const tooShort = query.trim().length < 3;
  const q = useUserSearch(query);
  const data = q.data;

  const grouped = (data?.results ?? []).reduce<Record<string, UserSearchResult[]>>((acc, r) => {
    (acc[r.source] ??= []).push(r);
    return acc;
  }, {});
  const sources = Object.keys(grouped);

  return (
    <Screen>
      <ScreenHeader
        title="Users"
        subtitle="Cross-product directory"
        right={<BackButton onPress={() => router.back()} />}
      />
      <View style={{ paddingHorizontal: space[4], paddingBottom: space[2] }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search by email" />
        {tooShort ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>
            Type at least 3 characters
          </Text>
        ) : null}
      </View>

      {tooShort ? (
        <EmptyState title="Search users" body="Find people across every product by email." />
      ) : q.isLoading ? (
        <LoadingRows />
      ) : sources.length === 0 ? (
        <EmptyState title="No matches" body="No identities matched this search." />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: space[10] }}>
          {data?.failures.length ? <Banner text="Some sources unavailable" tone="warning" /> : null}
          {sources.map((source) => (
            <View key={source} style={{ paddingHorizontal: space[4], paddingTop: space[3] }}>
              <SectionLabel>{sourceLabel(source)}</SectionLabel>
              <View style={{ gap: 8 }}>
                {(grouped[source] ?? []).map((r, i) => (
                  <ListRow
                    key={`${source}-${i}`}
                    title={r.label}
                    subtitle={r.sublabel ? `${r.email} · ${r.sublabel}` : r.email}
                    trailing={<Badge label={r.kind} />}
                    onPress={() => router.push(`/platform/user/${encodeURIComponent(r.email)}`)}
                  />
                ))}
              </View>
            </View>
          ))}
          {data?.truncated ? (
            <Text style={[text.caption, { color: p.mutedForeground, textAlign: 'center', marginTop: space[3] }]}>
              Showing first 100 matches
            </Text>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}
