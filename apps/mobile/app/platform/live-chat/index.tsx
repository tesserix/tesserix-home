// Otto platform inbox — the cross-product support queue. Waiting (pending,
// unclaimed), Active (my accepted chats), and Closed tabs; a product filter;
// per-row unread badge + product (tenant) badge. Polls every 10s while focused.

import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router, useIsFocused } from 'expo-router';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  EmptyState,
  FilterChips,
  ListRow,
  LoadingRows,
  Screen,
  ScreenHeader,
} from '../../../components/kit';
import { space } from '../../../lib/theme';
import { useOttoInbox, type OttoInboxParams } from '../../../lib/otto-hooks';
import { ottoTenantLabel, type OttoConversation } from '../../../lib/otto-contracts';

type TabKey = 'waiting' | 'active' | 'closed';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'active', label: 'Active' },
  { key: 'closed', label: 'Closed' },
];

const TENANT_FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All products' },
  { key: 'platform', label: 'Tesserix' },
  { key: 'homechef', label: 'HomeChef' },
  { key: 'fanzone', label: 'FanZone' },
  { key: 'mark8ly', label: 'mark8ly' },
  { key: 'horoscope', label: 'Horoscope' },
  { key: 'stockpilot', label: 'StockPilot' },
  { key: 'scrapper', label: 'Social Scraper' },
  { key: 'gameverse', label: 'GameVerse' },
  { key: 'mp-customer', label: 'Marketplace' },
];

function tabToParams(tab: TabKey, tenant: string): OttoInboxParams {
  const t = tenant || undefined;
  if (tab === 'waiting') return { status: 'pending', tenant: t };
  if (tab === 'active') return { status: 'active', tenant: t, assignee: 'mine' };
  return { status: 'closed', tenant: t };
}

function emptyBody(tab: TabKey): string {
  if (tab === 'waiting') return 'No customers are waiting right now.';
  if (tab === 'active') return 'You have no active chats.';
  return 'No closed conversations.';
}

export default function OttoInboxScreen() {
  const [tab, setTab] = useState<TabKey>('waiting');
  const [tenant, setTenant] = useState('');
  const focused = useIsFocused();

  const params = useMemo(() => tabToParams(tab, tenant), [tab, tenant]);
  const q = useOttoInbox(params, focused ? 10_000 : false);

  const rows = q.data?.conversations ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Live chat"
        subtitle="Support across every product"
        right={<BackButton onPress={() => router.back()} />}
      />
      <View style={{ paddingBottom: space[2] }}>
        <FilterChips options={TABS} value={tab} onChange={setTab} />
      </View>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={TENANT_FILTERS} value={tenant} onChange={setTenant} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing here" body={emptyBody(tab)} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <ConversationRow conv={item} />}
        />
      )}
    </Screen>
  );
}

function ConversationRow({ conv }: { conv: OttoConversation }) {
  const who = conv.customer?.name || conv.customer?.email || 'Anonymous';
  const reason = conv.intake?.reason ? titleCase(conv.intake.reason) : conv.subject || 'Support chat';
  const unread = conv.unread_count_staff > 0;
  return (
    <ListRow
      title={who}
      subtitle={`${reason} · ${formatRelative(conv.last_message_at)}`}
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {unread ? <Badge label={String(conv.unread_count_staff)} tone="danger" /> : null}
          <Badge label={ottoTenantLabel(conv.tenant_id)} tone="info" />
        </View>
      }
      onPress={() => router.push(`/platform/live-chat/${conv.id}`)}
    />
  );
}
