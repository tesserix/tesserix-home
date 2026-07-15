import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  ChevronLeft, ShoppingBag, ChefHat, ClipboardCheck, Truck, ShieldCheck, CalendarRange,
  Wallet, Star, LifeBuoy, Users, BadgeIndianRupee, UserCog, BarChart3, Scale, PackageX,
} from 'lucide-react-native';
import { ListRow, Screen, ScreenHeader, SectionLabel, Badge } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const SECTIONS = [
  { group: 'Operations', items: [
    { title: 'Orders', sub: 'All orders + status', icon: ShoppingBag, route: '/homechef/orders', live: true },
    { title: 'Chefs / Kitchens', sub: 'Verify, suspend, review', icon: ChefHat, route: '/homechef/chefs', live: true },
    { title: 'Approvals', sub: 'Onboarding queue', icon: ClipboardCheck, route: '/homechef/approvals', live: false },
    { title: 'Delivery', sub: '3PL providers + reconcile', icon: Truck, route: '/homechef/delivery', live: false },
    { title: 'FSSAI', sub: 'License compliance locks', icon: ShieldCheck, route: '/homechef/fssai', live: false },
    { title: 'Meal plans', sub: 'Tiffin subscriptions', icon: CalendarRange, route: '/homechef/meal-plans', live: false },
  ]},
  { group: 'Money', items: [
    { title: 'Cancellations', sub: 'Refund arbitration', icon: Scale, route: '/homechef/cancellations', live: true },
    { title: 'Delivery failures', sub: 'Confirm fault + refund', icon: PackageX, route: '/homechef/delivery-failures', live: true },
    { title: 'Payouts', sub: 'Weekly chef statements', icon: BadgeIndianRupee, route: '/homechef/payouts', live: false },
    { title: 'Wallets', sub: 'Customer credit', icon: Wallet, route: '/homechef/wallets', live: false },
  ]},
  { group: 'People & quality', items: [
    { title: 'Reviews', sub: 'Moderate ratings', icon: Star, route: '/homechef/reviews', live: false },
    { title: 'Support', sub: 'Tickets + refunds', icon: LifeBuoy, route: '/homechef/support', live: true },
    { title: 'Users', sub: 'Customers, chefs, drivers', icon: Users, route: '/homechef/users', live: false },
    { title: 'Staff', sub: 'Internal team + roles', icon: UserCog, route: '/homechef/staff', live: false },
    { title: 'Analytics', sub: 'KPIs + trends', icon: BarChart3, route: '/homechef/analytics', live: false },
  ]},
] as const;

export default function HomeChefHub() {
  const p = usePalette();
  const r = useRouter();
  return (
    <Screen>
      <ScreenHeader
        title="HomeChef"
        subtitle="Fe3dr marketplace admin"
        right={
          <Pressable onPress={() => r.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10] }}>
        {SECTIONS.map((sec) => (
          <View key={sec.group} style={{ marginTop: space[4] }}>
            <SectionLabel>{sec.group}</SectionLabel>
            <View style={{ gap: 8 }}>
              {sec.items.map((it) => (
                <ListRow
                  key={it.title}
                  title={it.title}
                  subtitle={it.sub}
                  icon={it.icon}
                  trailing={it.live ? undefined : <Badge label="Soon" tone="neutral" />}
                  onPress={it.live ? () => r.push(it.route as never) : undefined}
                />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
