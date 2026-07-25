// Mark8ly tenants — list + status change (active/suspended/archived).
import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTenants, useSetTenantStatus } from '../../../lib/mark8ly-hooks';
import type { Tenant, TenantStatus } from '../../../lib/mark8ly-contracts';
import { apiError } from '../../../lib/api';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, FilterChips,
  EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

const STATUS_OPTS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'archived', label: 'Archived' },
];
const STATUS_TONE: Record<TenantStatus, Tone> = { active: 'success', suspended: 'warning', archived: 'neutral' };
const NEXT: Record<TenantStatus, { label: string; to: TenantStatus }[]> = {
  active: [{ label: 'Suspend', to: 'suspended' }, { label: 'Archive', to: 'archived' }],
  suspended: [{ label: 'Reactivate', to: 'active' }, { label: 'Archive', to: 'archived' }],
  archived: [{ label: 'Reactivate', to: 'active' }],
};

export default function Tenants() {
  const [status, setStatus] = useState('all');
  const query = useTenants(status);
  const tenants = query.data?.tenants ?? [];

  return (
    <Screen>
      <ScreenHeader title="Tenants" subtitle="Mark8ly stores" right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], paddingBottom: 8 }}>
        <FilterChips options={STATUS_OPTS} value={status} onChange={setStatus} />
      </View>
      {query.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={tenants}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={query.isRefetching}
          onRefresh={() => query.refetch()}
          ListEmptyComponent={<EmptyState title="No tenants" body="No tenants match this filter." />}
          renderItem={({ item }) => <TenantCard t={item} />}
        />
      )}
    </Screen>
  );
}

function TenantCard({ t }: { t: Tenant }) {
  const p = usePalette();
  const setTenantStatus = useSetTenantStatus(t.id);

  function change(to: TenantStatus, label: string) {
    Alert.alert(`${label} tenant?`, `${t.name} will be set to ${to}.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: label, style: to === 'active' ? 'default' : 'destructive', onPress: () => setTenantStatus.mutate(to, { onError: (e) => Alert.alert('Failed', apiError(e)) }) },
    ]);
  }

  return (
    <Card>
      <Pressable onPress={() => router.push(`/mark8ly/tenants/${t.id}` as never)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{t.name}</Text>
          <Badge label={titleCase(t.status)} tone={STATUS_TONE[t.status]} />
        </View>
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
          {t.owner_email} · {formatRelative(t.created_at)}
        </Text>
      </Pressable>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {NEXT[t.status].map((n) => (
          <View key={n.to} style={{ flex: 1 }}>
            <Button label={n.label} variant="secondary" loading={setTenantStatus.isPending} onPress={() => change(n.to, n.label)} />
          </View>
        ))}
      </View>
    </Card>
  );
}
