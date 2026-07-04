import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft, UserCog } from 'lucide-react-native';
import { useStaff, useAdminAction, qk } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { titleCase } from '../../lib/format';
import { Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';
import type { StaffMember } from '../../lib/contracts';

export default function Staff() {
  const p = usePalette();
  const q = useStaff({ page: 1, limit: 50 });
  const action = useAdminAction(qk.staff({}));
  const rows = q.data?.data ?? [];

  function act(s: StaffMember) {
    const verb = s.isActive ? 'deactivate' : 'reactivate';
    Alert.alert(
      s.user?.email || 'Staff member',
      titleCase(s.staffRole),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: s.isActive ? 'Deactivate' : 'Reactivate',
          style: s.isActive ? 'destructive' : 'default',
          onPress: () => action.mutate({ method: 'put', path: `/staff/${s.id}/${verb}` }, { onError: (e) => Alert.alert('Failed', apiError(e)) }),
        },
      ],
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Staff" right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>} />
      {q.isLoading ? <LoadingRows /> : rows.length === 0 ? <EmptyState title="No staff" /> : (
        <FlatList
          data={rows}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={[item.user?.firstName, item.user?.lastName].filter(Boolean).join(' ') || item.user?.email || 'Staff'}
              subtitle={`${titleCase(item.staffRole)}${item.department ? ' · ' + item.department : ''}`}
              icon={UserCog}
              trailing={<Badge label={item.isActive ? 'Active' : 'Inactive'} tone={item.isActive ? 'success' : 'neutral'} />}
              onPress={() => act(item)}
            />
          )}
        />
      )}
    </Screen>
  );
}
