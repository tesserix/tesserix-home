import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useDeliveryProviders, useDeliveryReconciliation, useToggleDeliveryProvider } from '../../lib/platform-hooks';
import type { ProviderRow } from '../../lib/platform-contracts';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, formatCount, formatRelative } from '@tesserix/homechef-shared';
import {
  Badge, Button, Card, ListRow, LoadingRows, Screen, ScreenHeader, BackButton, SectionLabel, StatGrid, StatTile, StatusDot,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

export default function Delivery() {
  const p = usePalette();
  const providers = useDeliveryProviders();
  const recon = useDeliveryReconciliation();
  const toggle = useToggleDeliveryProvider();
  const { confirm } = useConfirm();
  const r = recon.data?.data;
  const rows = providers.data?.data ?? [];
  const refreshing = providers.isRefetching || recon.isRefetching;
  const refetchAll = () => { providers.refetch(); recon.refetch(); };

  async function onToggle(pr: ProviderRow) {
    const ok = await confirm({
      title: pr.is_enabled ? 'Disable provider' : 'Enable provider',
      message: `${pr.is_enabled ? 'Disable' : 'Enable'} ${pr.name} for new deliveries?`,
      confirmLabel: pr.is_enabled ? 'Disable' : 'Enable',
      tone: pr.is_enabled ? 'destructive' : 'default',
    });
    if (!ok) return;
    toggle.mutate(pr.id, { onError: (e) => Alert.alert('Toggle failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader title="Delivery (3PL)" subtitle="Providers & reconciliation" right={<BackButton onPress={() => router.back()} />} />
      {providers.isLoading || recon.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          <View style={{ paddingHorizontal: space[4] }}>
            <ListRow
              title="Cost intelligence"
              subtitle="Routing/weather spend, cache, zone pricing"
              trailing={<ChevronRight size={18} color={p.mutedForeground} />}
              onPress={() => router.push('/homechef/delivery-intelligence' as never)}
            />
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Reconciliation</SectionLabel></View>
          <StatGrid>
            <StatTile label="3PL deliveries" value={formatCount(r?.total_3pl_deliveries)} />
            <StatTile label="Provider cost" value={formatINR(r?.provider_cost)} />
            <StatTile label="Collected fees" value={formatINR(r?.collected_fee)} />
            <StatTile label="Margin" value={formatINR(r?.margin)} tone={r ? (r.margin < 0 ? 'danger' : 'success') : 'neutral'} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Providers</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4], gap: 8 }}>
            {rows.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No providers configured.</Text>
            ) : (
              rows.map((pr) => (
                <Card key={pr.id}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]}>{pr.name}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {pr.code} · priority {pr.priority} · {formatINR(pr.base_cost)} base
                      </Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {formatCount(pr.total_deliveries)} deliveries · {pr.success_rate.toFixed(1)}% · {pr.last_used_at ? formatRelative(pr.last_used_at) : 'never used'}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 8 }}>
                      <Badge label={pr.is_enabled ? 'Enabled' : 'Disabled'} tone={pr.is_enabled ? 'success' : 'neutral'} />
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <StatusDot tone={pr.is_active ? 'success' : 'neutral'} />
                        <Text style={[text.caption, { color: p.mutedForeground }]}>{pr.is_active ? 'active' : 'inactive'}</Text>
                      </View>
                    </View>
                  </View>
                  <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                    <Button
                      label={pr.is_enabled ? 'Disable' : 'Enable'}
                      variant="secondary"
                      tone={pr.is_enabled ? 'danger' : 'default'}
                      disabled={toggle.isPending}
                      onPress={() => onToggle(pr)}
                    />
                  </View>
                </Card>
              ))
            )}
          </View>

          <Text style={[text.caption, { color: p.mutedForeground, paddingHorizontal: space[4] }]}>
            Provider keys + connection test are managed in the Fe3dr API admin.
          </Text>
        </ScrollView>
      )}
    </Screen>
  );
}
