import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useUsers, useAdminAction } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR, titleCase, type UserWithStats } from '@tesserix/homechef-shared';
import {
  Badge, EmptyState, FilterChips, ListRow, LoadingRows, Screen, ScreenHeader, SearchField, type Tone,
} from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const ROLES = [
  { key: '', label: 'All' },
  { key: 'customer', label: 'Customers' },
  { key: 'chef', label: 'Chefs' },
  { key: 'delivery', label: 'Drivers' },
  { key: 'admin', label: 'Admins' },
] as const;

export default function Users() {
  const p = usePalette();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const q = useUsers({ search: search || undefined, role: role || undefined, page: 1, limit: 50 });
  const action = useAdminAction(['hc', 'users']);
  const rows = q.data?.data ?? [];

  function act(u: UserWithStats) {
    const name = `${u.firstName} ${u.lastName}`.trim() || u.email;
    Alert.alert(name, u.email, [
      { text: 'Open wallet', onPress: () => router.push(('/homechef/wallets?userId=' + u.id) as never) },
      {
        text: u.isActive ? 'Suspend' : 'Activate',
        style: u.isActive ? 'destructive' : 'default',
        onPress: () =>
          action.mutate(
            { method: 'put', path: `/users/${u.id}/${u.isActive ? 'suspend' : 'activate'}` },
            { onError: (e) => Alert.alert('Action failed', apiError(e)) },
          ),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  return (
    <Screen>
      <ScreenHeader
        title="Users"
        subtitle={q.data ? `${q.data.pagination.total} registered` : 'All accounts'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <SearchField value={search} onChangeText={setSearch} placeholder="Search name or email" />
      </View>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={ROLES as unknown as { key: string; label: string }[]} value={role} onChange={setRole} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No users" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(u) => u.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => {
            const name = `${item.firstName} ${item.lastName}`.trim() || item.email;
            const st: { label: string; tone: Tone } = item.isActive
              ? { label: 'Active', tone: 'success' }
              : { label: 'Suspended', tone: 'danger' };
            return (
              <ListRow
                title={name}
                subtitle={`${item.email} · ${titleCase(item.role)} · ${item.totalOrders} orders · ${formatINR(item.totalSpent)}`}
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
