// Mark8ly leads — CRM list with search + status/starred filters.
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Star } from 'lucide-react-native';
import { useLeads } from '../../../lib/mark8ly-hooks';
import type { Lead } from '../../../lib/mark8ly-contracts';
import type { LeadStatus } from '../../../lib/platform-contracts';
import { formatRelative, titleCase, formatCount } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, SearchField, FilterChips,
  EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

const STATUS_OPTS = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'converted', label: 'Converted' },
  { key: 'lost', label: 'Lost' },
];

const STATUS_TONE: Record<LeadStatus, Tone> = {
  new: 'info',
  contacted: 'warning',
  qualified: 'info',
  converted: 'success',
  lost: 'neutral',
};

function leadName(l: Lead): string {
  return l.name || l.company || l.instagram_handle || l.email || 'Unknown lead';
}

export default function Leads() {
  const p = usePalette();
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [starred, setStarred] = useState(false);
  const query = useLeads({ status, q, starred });
  const leads = query.data?.leads ?? [];

  return (
    <Screen>
      <ScreenHeader title="Leads" subtitle="Mark8ly CRM" right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], gap: 8, paddingBottom: 8 }}>
        <SearchField value={q} onChangeText={setQ} placeholder="Search leads…" />
        <FilterChips options={STATUS_OPTS} value={status} onChange={setStatus} />
        <FilterChips options={[{ key: 'off', label: 'All' }, { key: 'on', label: '★ Starred' }]} value={starred ? 'on' : 'off'} onChange={(k) => setStarred(k === 'on')} />
      </View>
      {query.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={leads}
          keyExtractor={(l) => l.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={query.isRefetching}
          onRefresh={() => query.refetch()}
          ListEmptyComponent={<EmptyState title="No leads" body="No leads match this filter." />}
          renderItem={({ item }) => (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {item.is_starred ? <Star size={14} color={p.warning} fill={p.warning} /> : null}
                <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1} onPress={() => router.push(`/mark8ly/leads/${item.id}`)}>
                  {leadName(item)}
                </Text>
                <Badge label={titleCase(item.status)} tone={STATUS_TONE[item.status]} />
              </View>
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1} onPress={() => router.push(`/mark8ly/leads/${item.id}`)}>
                {[item.email, item.instagram_handle, item.location].filter(Boolean).join(' · ') || '—'}
              </Text>
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
                {[item.owner ? `owner ${item.owner}` : null, item.activity_count != null ? `${formatCount(item.activity_count)} activities` : null, formatRelative(item.created_at)].filter(Boolean).join(' · ')}
              </Text>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}
