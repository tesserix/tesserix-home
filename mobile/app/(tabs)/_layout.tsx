import { Tabs } from 'expo-router';
import { LayoutDashboard, LayoutGrid, Server, Menu } from 'lucide-react-native';
import { usePalette, font } from '../../lib/theme';

export default function TabsLayout() {
  const p = usePalette();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: p.foreground,
        tabBarInactiveTintColor: p.mutedForeground,
        tabBarStyle: {
          backgroundColor: p.surface,
          borderTopColor: p.border,
          borderTopWidth: 0.5,
          height: 84,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontFamily: font.sansMedium, fontSize: 11 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Overview', tabBarIcon: ({ color, size }) => <LayoutDashboard color={color} size={size} /> }} />
      <Tabs.Screen name="apps" options={{ title: 'Apps', tabBarIcon: ({ color, size }) => <LayoutGrid color={color} size={size} /> }} />
      <Tabs.Screen name="platform" options={{ title: 'Platform', tabBarIcon: ({ color, size }) => <Server color={color} size={size} /> }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: ({ color, size }) => <Menu color={color} size={size} /> }} />
    </Tabs>
  );
}
