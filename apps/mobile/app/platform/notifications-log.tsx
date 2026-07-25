// Notifications log — SendGrid email delivery metrics + recent events.
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useEmailMetrics, useEmailRecent } from '../../lib/platform-hooks';
import type { EmailMetricsRow, EmailEventLogRow } from '../../lib/platform-contracts';
import { formatCount, formatPct, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, StatGrid, StatTile, SectionLabel, Badge,
  EmptyState, LoadingRows, FilterChips, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const DAY_OPTS = [
  { key: '7', label: '7d' },
  { key: '30', label: '30d' },
  { key: '90', label: '90d' },
];

function sum(rows: EmailMetricsRow[], f: (r: EmailMetricsRow) => number): number {
  return rows.reduce((a, r) => a + f(r), 0);
}

function eventTone(type: string): Tone {
  const t = type.toLowerCase();
  if (t.includes('bounce') || t.includes('dropped') || t.includes('spam')) return 'danger';
  if (t.includes('deliver')) return 'success';
  if (t.includes('open') || t.includes('click')) return 'info';
  if (t.includes('unsub')) return 'warning';
  return 'neutral';
}

export default function NotificationsLog() {
  const p = usePalette();
  const [days, setDays] = useState('30');
  const [product, setProduct] = useState('all');

  const metrics = useEmailMetrics(Number(days), product === 'all' ? undefined : product);
  const recent = useEmailRecent(product === 'all' ? undefined : product);

  const rows = metrics.data?.rows ?? [];
  const productOpts = useMemo(() => {
    const set = Array.from(new Set(rows.map((r) => r.product).filter(Boolean)));
    return [{ key: 'all', label: 'All' }, ...set.map((pr) => ({ key: pr, label: pr }))];
  }, [rows]);

  const sent = sum(rows, (r) => r.sent);
  const delivered = sum(rows, (r) => r.delivered);
  const opens = sum(rows, (r) => r.opens);
  const clicks = sum(rows, (r) => r.clicks);
  const bounces = sum(rows, (r) => r.bounces);
  const unsub = sum(rows, (r) => r.unsubscribes);
  const events = recent.data?.events ?? [];

  return (
    <Screen>
      <ScreenHeader title="Notifications log" subtitle="Email delivery" right={<BackButton onPress={() => router.back()} />} />
      {metrics.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
        >
          <View style={{ paddingHorizontal: space[4], gap: 8 }}>
            <FilterChips options={DAY_OPTS} value={days} onChange={setDays} />
            {productOpts.length > 1 ? <FilterChips options={productOpts} value={product} onChange={setProduct} /> : null}
          </View>

          <StatGrid>
            <StatTile label="Sent" value={formatCount(sent)} />
            <StatTile label="Delivered" value={sent ? formatPct((delivered / sent) * 100) : '—'} />
            <StatTile label="Opens" value={delivered ? formatPct((opens / delivered) * 100) : '—'} />
            <StatTile label="Clicks" value={formatCount(clicks)} />
            <StatTile label="Bounces" value={formatCount(bounces)} tone={bounces > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Unsub" value={formatCount(unsub)} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Recent events</SectionLabel>
            {events.length === 0 ? (
              <Card><EmptyState title="No events" body="No recent email events for this filter." /></Card>
            ) : (
              <View style={{ gap: 8 }}>
                {events.map((e) => (
                  <EventCard key={e.id} e={e} />
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

function EventCard({ e }: { e: EmailEventLogRow }) {
  const p = usePalette();
  const meta = [e.product, e.templateKey].filter(Boolean).join(' · ');
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Badge label={titleCase(e.eventType)} tone={eventTone(e.eventType)} />
        <View style={{ flex: 1 }} />
        <Text style={[text.caption, { color: p.mutedForeground }]}>{formatRelative(e.eventAt)}</Text>
      </View>
      {e.recipient ? (
        <Text style={[text.body, { color: p.foreground, marginTop: 8 }]} numberOfLines={1}>{e.recipient}</Text>
      ) : null}
      {meta ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{meta}</Text>
      ) : null}
      {e.reason ? (
        <Text style={[text.caption, { color: p.destructiveFg, marginTop: 4 }]} numberOfLines={2}>{e.reason}</Text>
      ) : null}
    </Card>
  );
}
