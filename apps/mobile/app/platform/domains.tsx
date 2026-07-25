// Custom domains — DNS & SSL health per tenant domain. Verify re-runs DNS/ownership
// checks; manual-DNS domains can also refresh their cert issuance status.

import { useMemo, useState } from 'react';
import { Alert, FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useCustomDomains, useDomainAction } from '../../lib/platform-hooks';
import type { CustomDomain } from '../../lib/platform-contracts';
import { apiError } from '../../lib/api';
import { formatDate } from '@tesserix/homechef-shared';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  FilterChips,
  LoadingRows,
  Screen,
  ScreenHeader,
  StatGrid,
  StatTile,
  BackButton,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

type StatusFilter = 'all' | 'active' | 'pending' | 'verifying' | 'failed';
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'pending', label: 'Pending' },
  { key: 'verifying', label: 'Verifying' },
  { key: 'failed', label: 'Failed' },
];

function statusTone(s: CustomDomain['status']): Tone {
  if (s === 'active') return 'success';
  if (s === 'pending') return 'warning';
  if (s === 'verifying') return 'info';
  return 'danger';
}

function sslTone(s: CustomDomain['sslStatus']): Tone {
  if (s === 'active') return 'success';
  if (s === 'pending') return 'warning';
  return 'danger';
}

function certTone(s: CustomDomain['certStatus']): Tone {
  if (s === 'ready') return 'success';
  if (s === 'issuing') return 'info';
  if (s === 'pending') return 'warning';
  return 'danger';
}

function needsAttention(d: CustomDomain): boolean {
  return d.status === 'failed' || d.sslStatus === 'failed' || d.certStatus === 'failed';
}

export default function Domains() {
  const p = usePalette();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const q = useCustomDomains();
  const action = useDomainAction();
  const domains = useMemo(() => q.data?.domains ?? [], [q.data]);

  const counts = useMemo(() => {
    let active = 0;
    let pending = 0;
    let failed = 0;
    for (const d of domains) {
      if (d.status === 'active') active += 1;
      if (d.status === 'pending' || d.status === 'verifying') pending += 1;
      if (needsAttention(d)) failed += 1;
    }
    return { active, pending, failed };
  }, [domains]);

  const filtered = useMemo(() => {
    if (filter === 'all') return domains;
    if (filter === 'failed') return domains.filter(needsAttention);
    return domains.filter((d) => d.status === filter);
  }, [domains, filter]);

  function verify(d: CustomDomain) {
    action.mutate(
      { id: d.id, action: 'verify' },
      {
        onError: (e) => Alert.alert('Verify failed', apiError(e)),
        onSuccess: () => Alert.alert('Re-verify queued', `${d.domain} will be re-checked shortly.`),
      },
    );
  }

  function refreshCert(d: CustomDomain) {
    action.mutate(
      { id: d.id, action: 'refresh-status' },
      {
        onError: (e) => Alert.alert('Refresh failed', apiError(e)),
        onSuccess: () => Alert.alert('Cert refresh queued', `Certificate status for ${d.domain} is refreshing.`),
      },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Custom domains"
        subtitle="DNS & SSL"
        right={<BackButton onPress={() => router.back()} />}
      />

      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ marginHorizontal: -space[4], marginBottom: space[2] }}>
              <View style={{ paddingBottom: space[3] }}>
                <StatGrid>
                  <StatTile label="Domains" value={String(domains.length)} />
                  <StatTile label="Active" value={String(counts.active)} tone="success" />
                  <StatTile label="Pending" value={String(counts.pending)} tone="warning" />
                  <StatTile label="Failed" value={String(counts.failed)} tone="danger" />
                </StatGrid>
              </View>
              {counts.failed > 0 ? (
                <Banner text={`${counts.failed} domains need attention`} tone="danger" />
              ) : null}
              <View style={{ paddingBottom: space[2] }}>
                <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
              </View>
            </View>
          }
          ListEmptyComponent={<EmptyState title="No custom domains" body="Nothing matches this filter." />}
          renderItem={({ item }) => (
            <DomainCard
              domain={item}
              busy={action.isPending}
              onVerify={() => verify(item)}
              onRefreshCert={() => refreshCert(item)}
            />
          )}
        />
      )}
    </Screen>
  );

  function DomainCard({
    domain,
    busy,
    onVerify,
    onRefreshCert,
  }: {
    domain: CustomDomain;
    busy: boolean;
    onVerify: () => void;
    onRefreshCert: () => void;
  }) {
    const owner = domain.tenantName ?? domain.tenantSlug ?? domain.tenantId;
    const err = domain.errorMessage ?? domain.certError;
    return (
      <Card>
        <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{domain.domain}</Text>
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{owner}</Text>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          <Badge label={domain.status} tone={statusTone(domain.status)} />
          <Badge label={`SSL ${domain.sslStatus}`} tone={sslTone(domain.sslStatus)} />
          <Badge label={`cert ${domain.certStatus}`} tone={certTone(domain.certStatus)} />
        </View>

        {domain.dnsMethod === 'manual' && domain.cnameTarget ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]} numberOfLines={1}>
            CNAME → {domain.cnameTarget}
          </Text>
        ) : null}
        {err ? (
          <Text style={[text.caption, { color: p.destructiveFg, marginTop: 6 }]} numberOfLines={3}>{err}</Text>
        ) : null}
        {domain.verifiedAt ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>
            Verified {formatDate(domain.verifiedAt)}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <View style={{ flex: 1 }}>
            <Button label="Verify" onPress={onVerify} disabled={busy} />
          </View>
          {domain.dnsMethod === 'manual' ? (
            <View style={{ flex: 1 }}>
              <Button label="Refresh cert" variant="secondary" onPress={onRefreshCert} disabled={busy} />
            </View>
          ) : null}
        </View>
      </Card>
    );
  }
}
