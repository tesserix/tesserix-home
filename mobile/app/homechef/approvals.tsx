import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft, ClipboardCheck } from 'lucide-react-native';
import { useApprovals, useAdminAction, qk } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { titleCase } from '../../lib/format';
import { Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader, FilterChips, type Tone } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';
import type { ApprovalRequest } from '../../lib/contracts';

const TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'info_requested', label: 'Info requested' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
] as const;

function priorityTone(pr: string): Tone {
  if (pr === 'urgent') return 'danger';
  if (pr === 'high') return 'warning';
  if (pr === 'low') return 'neutral';
  return 'info';
}

export default function Approvals() {
  const [status, setStatus] = useState('pending');
  const p = usePalette();
  const q = useApprovals({ status, page: 1, limit: 30 });
  const action = useAdminAction(qk.approvals({}));
  const rows = q.data?.data ?? [];

  function act(a: ApprovalRequest) {
    Alert.alert(
      a.title,
      `${a.kitchenName ?? ''}${a.requestedByEmail ? ' · ' + a.requestedByEmail : ''}`,
      [
        { text: 'Approve', onPress: () => run(`/approvals/${a.id}/approve`) },
        { text: 'Request info', onPress: () => run(`/approvals/${a.id}/request-info`, 'More information needed') },
        { text: 'Reject', style: 'destructive', onPress: () => run(`/approvals/${a.id}/reject`, 'Rejected by admin') },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }
  function run(path: string, notes?: string) {
    action.mutate({ method: 'put', path, body: notes ? { notes } : undefined }, { onError: (e) => Alert.alert('Failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader title="Approvals" subtitle="Onboarding queue" right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>} />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={TABS as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? <LoadingRows /> : rows.length === 0 ? <EmptyState title="Nothing here" body="No requests in this state." /> : (
        <FlatList
          data={rows}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={item.title}
              subtitle={`${titleCase(item.type)}${item.kitchenName ? ' · ' + item.kitchenName : ''}`}
              icon={ClipboardCheck}
              trailing={<Badge label={titleCase(item.priority)} tone={priorityTone(item.priority)} />}
              onPress={status === 'pending' || status === 'info_requested' ? () => act(item) : undefined}
            />
          )}
        />
      )}
    </Screen>
  );
}
