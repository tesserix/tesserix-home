import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useChefs, useAdminAction, qk } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR } from '../../lib/format';
import {
  Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader, FilterChips, SearchField, type Tone,
} from '../../components/kit';
import { usePalette, space } from '../../lib/theme';
import type { ChefWithStats } from '../../lib/contracts';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'verified', label: 'Verified' },
  { key: 'suspended', label: 'Suspended' },
] as const;

function chefState(c: ChefWithStats): { label: string; tone: Tone } {
  if (!c.isActive) return { label: 'Suspended', tone: 'danger' };
  if (!c.isVerified) return { label: 'Pending', tone: 'warning' };
  return { label: 'Verified', tone: 'success' };
}

export default function Chefs() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const p = usePalette();
  const q = useChefs({ status: status || undefined, search: search || undefined, page: 1, limit: 30 });
  const action = useAdminAction(qk.chefs({}));
  const rows = q.data?.data ?? [];

  function act(c: ChefWithStats) {
    const options: { text: string; run?: () => void; style?: 'destructive' | 'cancel' }[] = [];
    if (!c.isVerified) options.push({ text: 'Verify', run: () => run(`/chefs/${c.id}/verify`) });
    if (c.isActive) options.push({ text: 'Suspend', style: 'destructive', run: () => run(`/chefs/${c.id}/suspend`) });
    else options.push({ text: 'Reinstate', run: () => run(`/chefs/${c.id}/verify`) });
    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(c.businessName, c.ownerEmail, options.map((o) => ({ text: o.text, style: o.style, onPress: o.run })));
  }
  function run(path: string) {
    action.mutate(
      { method: 'put', path },
      { onError: (e) => Alert.alert('Action failed', apiError(e)) },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Chefs"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <SearchField value={search} onChangeText={setSearch} placeholder="Search kitchens" />
      </View>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No kitchens" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => {
            const st = chefState(item);
            return (
              <ListRow
                title={item.businessName}
                subtitle={`${item.ownerName} · ${item.totalOrders} orders · ${formatINR(item.totalRevenue)}`}
                trailing={<Badge label={st.label} tone={st.tone} />}
                onPress={() => act(item)}
              />
            );
          }}
        />
      )}
    </Screen>
  );
}
