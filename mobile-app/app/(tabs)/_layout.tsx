import { Tabs } from 'expo-router';
import React from 'react';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAppTheme } from '@/contexts/theme-context';

export default function TabLayout() {
  const { theme } = useAppTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted,
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Bildirimler',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="bell" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Dosyalar',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="folder" color={color} />,
        }}
      />
      <Tabs.Screen
        name="aktarim"
        options={{
          title: 'Aktarım',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="upload" color={color} />,
        }}
      />
    </Tabs>
  );
}
