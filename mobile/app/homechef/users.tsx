import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useUsers, useAdminAction, qk } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR } from '../../lib/format';
import { Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader, FilterChips, SearchField } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';
import type { UserWithStats } from '../../lib/contracts';

const ROLES = [
  { key: '', label: 'All' },
  { key: 'customer', label: 'Customers' },
  { key: 'chef', label: 'Chefs' },
  { key: 'delivery', label: 'Drivers' },
  { key: 'admin', label: 'Admins' },
] as const;

export default function Users() {
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');
  const p = usePalette();
  const q = useUsers({ role: role || undefined, search: search || undefined, page: 1, limit: 30 });
  const action = useAdminAction(qk.users({}));
  const rows = q.data?.data ?? [];

  function act(u: UserWithStats) {
    const verb = u.isActive ? 'suspend' : 'activate';
    Alert.alert(
      `${u.firstName} ${u.lastName}`.trim() || u.email,
      u.email,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: u.isActive ? 'Suspend' : 'Activate',
          style: u.isActive ? 'destructive' : 'default',
          onPress: () =>
            action.mutate({ method: 'put', path: `/users/${u.id}/${verb}` }, { onError: (e) => Alert.alert('Failed', apiError(e)) }),
        },
      ],
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Users"
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
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
          renderItem={({ item }) => (
            <ListRow
              title={`${item.firstName} ${item.lastName}`.trim() || item.email}
              subtitle={`${item.role} · ${item.totalOrders} orders · ${formatINR(item.totalSpent)}`}
              trailing={<Badge label={item.isActive ? 'Active' : 'Suspended'} tone={item.isActive ? 'success' : 'danger'} />}
              onPress={() => act(item)}
            />
          )}
        />
      )}
    </Screen>
  );
}
