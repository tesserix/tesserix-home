import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChefHat, Store, Bot } from 'lucide-react-native';
import { ListRow, Screen, ScreenHeader } from '../../components/kit';
import { Badge } from '../../components/kit';
import { space } from '../../lib/theme';

const PRODUCTS = [
  { key: 'homechef', title: 'HomeChef · Fe3dr', subtitle: 'Home-cooking marketplace', icon: ChefHat, route: '/homechef', live: true },
  { key: 'mark8ly', title: 'Mark8ly', subtitle: 'Marketplace SaaS · multi-tenant', icon: Store, route: '/mark8ly', live: false },
  { key: 'devai', title: 'DevAI', subtitle: 'Developer AI platform', icon: Bot, route: '/devai', live: false },
] as const;

export default function Apps() {
  const router = useRouter();
  return (
    <Screen>
      <ScreenHeader title="Apps" subtitle="Per-product administration" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[10] }}>
        {PRODUCTS.map((prod) => (
          <ListRow
            key={prod.key}
            title={prod.title}
            subtitle={prod.subtitle}
            icon={prod.icon}
            trailing={prod.live ? undefined : <Badge label="Soon" tone="neutral" />}
            onPress={prod.live ? () => router.push(prod.route as never) : undefined}
          />
        ))}
      </ScrollView>
    </Screen>
  );
}
