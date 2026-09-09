import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { DeviceProvider } from '@/contexts/device-context';
import { NotificationsProvider } from '@/contexts/notifications-context';
import { ThemeModeProvider, useAppTheme } from '@/contexts/theme-context';
import { registerDownloadForegroundService } from '@/services/downloadForegroundService';

export const unstable_settings = {
  anchor: '(tabs)',
};

// Notifee'nin foreground service geri çağırımı, herhangi bir bileşen
// render edilmeden önce, modül kapsamında bir kere kayıtlı olmalı.
registerDownloadForegroundService();

function Navigation() {
  const { dark } = useAppTheme();

  return (
    <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair-device" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="server-settings" options={{ presentation: 'modal', headerShown: false }} />
      </Stack>
      <StatusBar style={dark ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    // Bildirimler sekmesindeki swipe-to-dismiss (react-native-gesture-handler)
    // için gerekli - Android'de gerçek bir native kök view (kurulu paketin
    // kaynağında doğrulandı: GestureHandlerRootView.android.tsx,
    // RNGestureHandlerRootViewNativeComponent render ediyor), sadece bir
    // stil sarmalayıcısı değil.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeModeProvider>
        <DeviceProvider>
          <NotificationsProvider>
            <Navigation />
          </NotificationsProvider>
        </DeviceProvider>
      </ThemeModeProvider>
    </GestureHandlerRootView>
  );
}
