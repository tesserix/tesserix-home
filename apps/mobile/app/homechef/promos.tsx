import { useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { formatDate, formatINR, type Promo } from '@tesserix/homechef-shared';
import {
  Badge, BackButton, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, SearchField, StatTile,
} from '../../components/kit';
import { PromoCreateForm, PromoEditForm, APPLICABLE_LABEL } from '../../components/homechef/promo-forms';
import { usePromoAnalytics, usePromos, useDeactivatePromo } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, space, text } from '../../lib/theme';

const PAGE_LIMIT = 20;

export default function Promos() {
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // Debounce the search box (300ms) and reset to page 1 on a new term.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(rawSearch.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [rawSearch]);

  const q = usePromos({ search: search || undefined, page, limit: PAGE_LIMIT });
  const promos = q.data?.data ?? [];
  const meta = q.data?.pagination;

  return (
    <Screen>
      <ScreenHeader
        title="Promos"
        subtitle="Discount codes"
        right={<BackButton onPress={() => router.back()} />}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[10], gap: space[3] }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
      >
        <View style={{ paddingHorizontal: space[4], gap: 10 }}>
          <SearchField value={rawSearch} onChangeText={setRawSearch} placeholder="Search codes" />
          <Button
            label={creating ? 'Close new promo' : 'New promo'}
            variant={creating ? 'secondary' : 'primary'}
            onPress={() => setCreating((v) => !v)}
          />
          {creating ? <PromoCreateForm onDone={() => setCreating(false)} /> : null}
        </View>

        {q.isLoading ? (
          <LoadingRows />
        ) : promos.length === 0 ? (
          <EmptyState title="No promos" body={search ? 'No codes match your search.' : 'Create your first discount code.'} />
        ) : (
          <View style={{ paddingHorizontal: space[4], gap: 10 }}>
            {promos.map((promo) => (
              <PromoRow key={promo.id} promo={promo} open={openId === promo.id} onToggle={() => setOpenId((id) => (id === promo.id ? null : promo.id))} />
            ))}
          </View>
        )}

        {meta && (meta.hasPrev || meta.hasNext) ? (
          <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: space[4] }}>
            <View style={{ flex: 1 }}><Button label="Previous" variant="secondary" disabled={!meta.hasPrev} onPress={() => setPage((n) => Math.max(1, n - 1))} /></View>
            <View style={{ flex: 1 }}><Button label="Next" variant="secondary" disabled={!meta.hasNext} onPress={() => setPage((n) => n + 1)} /></View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function PromoRow({ promo, open, onToggle }: { promo: Promo; open: boolean; onToggle: () => void }) {
  const p = usePalette();
  const { confirm } = useConfirm();
  const deactivate = useDeactivatePromo();
  const analytics = usePromoAnalytics(promo.id, open);

  const discount = promo.discountType === 'percentage' ? `${promo.discountValue}%` : formatINR(promo.discountValue);
  const a = analytics.data;

  const tiles: { label: string; value: string }[] = [
    { label: 'Redemptions', value: String(a?.redemptions ?? 0) },
    { label: 'Total discount', value: formatINR(a?.totalDiscount) },
    { label: 'Unique users', value: String(a?.uniqueUsers ?? 0) },
    { label: 'Budget left', value: promo.budgetCap > 0 ? formatINR(a?.budgetRemaining) : 'Uncapped' },
    { label: 'Budget used', value: promo.budgetCap > 0 ? `${(a?.budgetUtilisation ?? 0).toFixed(1)}%` : '—' },
  ];

  return (
    <Card>
      <Pressable onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[text.title, { color: p.foreground }]}>{promo.code}</Text>
            <Badge label={promo.isActive ? 'Active' : 'Inactive'} tone={promo.isActive ? 'success' : 'neutral'} />
          </View>
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
            {discount} · {APPLICABLE_LABEL[promo.applicableTo] ?? promo.applicableTo} · {promo.fundingSource} · used {promo.usageCount}/{promo.usageLimit || '∞'}
          </Text>
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
            Budget {formatINR(promo.budgetSpent)}/{promo.budgetCap > 0 ? formatINR(promo.budgetCap) : '∞'} · expires {promo.validUntil ? formatDate(promo.validUntil) : 'never'}
          </Text>
        </View>
        {open ? <ChevronDown size={18} color={p.mutedForeground} /> : <ChevronRight size={18} color={p.mutedForeground} />}
      </Pressable>

      {open ? (
        <View style={{ marginTop: 12, gap: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {tiles.map((t) => (
              <View key={t.label} style={{ flexGrow: 1, flexBasis: '30%', minWidth: 96 }}>
                <StatTile label={t.label} value={t.value} />
              </View>
            ))}
          </View>
          <PromoEditForm promo={promo} onDone={onToggle} />
          {promo.isActive ? (
            <Button
              label={deactivate.isPending ? 'Deactivating…' : 'Deactivate code'}
              variant="secondary"
              tone="danger"
              loading={deactivate.isPending}
              onPress={async () => {
                const ok = await confirm({
                  title: 'Deactivate code?',
                  message: 'The code stops working immediately. It can be reactivated later.',
                  confirmLabel: 'Deactivate',
                  tone: 'destructive',
                });
                if (ok) deactivate.mutate(promo.id, { onError: (e) => Alert.alert('Could not deactivate', apiError(e)) });
              }}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
