// platform-settings.tsx — HomeChef platform config: fees/payouts, subscription
// pricing, referrals. Three independently-saved editable cards.
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { BackButton, LoadingRows, Screen, ScreenHeader } from '../../components/kit';
import { PolicyCard, PricingCard, ReferralCard } from '../../components/homechef/settings-sections';
import { usePlatformPolicy, useSubscriptionPricing, useReferralConfig } from '../../lib/hooks';
import { space } from '../../lib/theme';

export default function PlatformSettings() {
  const policy = usePlatformPolicy();
  const pricing = useSubscriptionPricing();
  const referral = useReferralConfig();
  const loading = policy.isLoading || pricing.isLoading || referral.isLoading;
  const refetchAll = () => { policy.refetch(); pricing.refetch(); referral.refetch(); };

  return (
    <Screen>
      <ScreenHeader title="Platform settings" subtitle="Fees, pricing & referrals" right={<BackButton onPress={() => router.back()} />} />
      {loading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={policy.isRefetching || pricing.isRefetching || referral.isRefetching} onRefresh={refetchAll} />}
        >
          <PolicyCard />
          <PricingCard />
          <ReferralCard />
        </ScrollView>
      )}
    </Screen>
  );
}
