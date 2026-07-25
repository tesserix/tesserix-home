// Tenant detail (read-only) — identity + subscription/billing block.
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTenant, useTenantBilling } from '../../../lib/mark8ly-hooks';
import type { TenantStatus } from '../../../lib/mark8ly-contracts';
import { formatDateTime, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Metric, SectionLabel, EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

const STATUS_TONE: Record<TenantStatus, Tone> = { active: 'success', suspended: 'warning', archived: 'neutral' };

export default function TenantDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTenant(id ?? '');
  const b = useTenantBilling(id ?? '');
  const tenant = t.data?.tenant;
  const billing = b.data;

  return (
    <Screen>
      <ScreenHeader title={tenant?.name ?? 'Tenant'} subtitle={tenant?.owner_email} right={<BackButton onPress={() => router.back()} />} />
      {t.isLoading ? (
        <LoadingRows />
      ) : !tenant ? (
        <Card><EmptyState title="Tenant not found" /></Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[text.title, { color: p.foreground, flex: 1 }]}>Identity</Text>
              <Badge label={titleCase(tenant.status)} tone={STATUS_TONE[tenant.status]} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
              <Metric label="Owner" value={tenant.owner_email} />
              <Metric label="Created" value={formatRelative(tenant.created_at)} />
            </View>
            <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]} numberOfLines={1}>{tenant.id}</Text>
          </Card>

          <View>
            <SectionLabel>Subscription</SectionLabel>
            {b.isLoading ? (
              <LoadingRows rows={2} />
            ) : !billing || !billing.subscription ? (
              <Card><EmptyState title="No subscription" body={billing?.trial ? 'In trial.' : 'No active subscription.'} /></Card>
            ) : (
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Badge label={billing.subscription.plan} tone="info" />
                  <Badge label={titleCase(billing.subscription.status)} tone={billing.subscription.status === 'active' ? 'success' : 'warning'} />
                  {billing.synthesized ? <Badge label="synthetic" tone="neutral" /> : null}
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
                  {billing.trial?.daysRemaining != null ? <Metric label="Trial days" value={String(billing.trial.daysRemaining)} /> : null}
                  {billing.lifetimeRevenue ? <Metric label="Lifetime rev" value={`${billing.lifetimeRevenue.currency} ${billing.lifetimeRevenue.amount}`} /> : null}
                  {billing.subscription.current_period_end ? <Metric label="Renews" value={formatDateTime(billing.subscription.current_period_end)} /> : null}
                  <Metric label="Cancels EOP" value={billing.subscription.cancel_at_period_end ? 'Yes' : 'No'} />
                </View>
              </Card>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
