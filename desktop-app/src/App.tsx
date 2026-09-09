import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useOverlayPath } from 'expo-router';

import { ThemeModeProvider, useAppTheme } from '@/contexts/theme-context';
import { DeviceProvider, useDevices } from '@/contexts/device-context';

// Bildirimler masaüstünde AYRI bir ekran: gelen/giden/başarısız aktarım
// geçmişini yalnızca gömülü sunucunun çalıştığı bu makine tutabiliyor
// (bkz. electron/main/transfers.ts). Telefonun kendi Bildirimler ekranı
// (mobile-app/app/(tabs)/index.tsx) bilinçli olarak DEĞİŞTİRİLMEDİ.
import BildirimlerScreen from './screens/BildirimlerScreen';
import DosyalarScreen from '@/app/(tabs)/explore';
import AktarimScreen from '@/app/(tabs)/aktarim';
import PairDeviceScreen from '@/app/pair-device';
import ServerSettingsScreen from '@/app/server-settings';
import { ErrorBoundary } from './ErrorBoundary';
import SunucuScreen from './screens/SunucuScreen';

type TabKey = 'bildirimler' | 'dosyalar' | 'aktarim' | 'sunucu';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'bildirimler', label: 'Bildirimler', icon: 'notifications-outline' },
  { key: 'dosyalar', label: 'Dosyalar', icon: 'folder-outline' },
  { key: 'aktarim', label: 'Aktarım', icon: 'arrow-up-circle-outline' },
  { key: 'sunucu', label: 'Sunucu', icon: 'server-outline' },
];

/**
 * Mobilde pull-to-refresh vardı, masaüstünde fareyle bu doğal çalışmıyor
 * (bkz. görev tanımı). Bildirimler/Aktarım ekranları mobile-app'ten
 * DEĞİŞTİRİLMEDEN yeniden kullanıldığından (bu turun kapsamı dışı: "mobil
 * tarafı değiştirme"), içlerine bir buton enjekte edilemiyor - bunun yerine
 * ekranın ÜSTÜNE, tema butonunun hemen soluna, kendi tema-butonuyla aynı
 * boyut/konumda yüzen bir buton kondu. Basılınca:
 * - useDevices().refresh() çağrılır (dışarıdan tetiklenebilen TEK paylaşılan
 *   veri kaynağı - cihaz listesi/durumu, her iki ekranda da gösteriliyor)
 * - ekran `key` değiştirilerek YENİDEN MOUNT edilir, kendi mount-time
 *   useEffect'lerini (varsa) tekrar tetikler
 * BİLEREK remount YOK: Aktarım'da kullanıcının seçtiği dosya/yazdığı not
 * kaybolur (kötü UX, veri kaybı). Aktarım'ın kendi "SUNUCU" kartına
 * dokunmak zaten checkServer()'ı tetikliyor (mevcut mobil davranış) - bu
 * buton onun yerini almıyor, sadece cihaz listesini tazeliyor.
 *
 * Bildirimler de artık remount EDİLMİYOR: seçilebilir liste eklendikten
 * sonra remount, kullanıcının işaretlediği kayıtları ve filtresini siliyordu.
 * Onun yerine ekran kendi `reload` fonksiyonunu buraya kaydediyor
 * (registerReload); tuş hem cihaz listesini hem bildirim listesini bekliyor,
 * böylece dönüş animasyonu ekran GERÇEKTEN güncellenene kadar sürüyor.
 */
function FloatingRefreshButton({
  onPress,
  insetsTop,
}: {
  onPress: () => void | Promise<unknown>;
  insetsTop: number;
}) {
  const { theme: t } = useAppTheme();
  const [spinning, setSpinning] = useState(false);
  const spin = useRef(new Animated.Value(0)).current;
  /** Veri hâlâ geliyor mu? Animasyon her tur sonunda buna bakıp devam/dur kararı verir. */
  const loadingRef = useRef(false);

  /**
   * Dönüş TUR TUR sürüyor: her tur bittiğinde veri hâlâ geliyorsa yeni bir
   * tur başlıyor, gelmişse ikon tam 0°'de duruyor.
   *
   * Neden döngü (Animated.loop) değil: loop'u ortasında durdurmak ikonu
   * yamuk bırakıyordu. Neden "işi bekleyip hemen durdur" da değil: yerel
   * sunucuda yenileme ~120 ms sürüyor ve React o kadar kısa sürede
   * spinning=true durumunu HİÇ render etmiyordu (ölçüldü: transform hiç
   * değişmiyor) - animasyon başlamadan bitiyordu. Tur tabanlı yaklaşım
   * ikisini birden çözüyor: animasyon her zaman görünür, veri gelmeden ASLA
   * durmuyor ve durduğunda hep 0°'de duruyor.
   */
  useEffect(() => {
    if (!spinning) return;
    let cancelled = false;

    const runTurn = () => {
      if (cancelled) return;
      spin.setValue(0);
      // useNativeDriver BİLEREK false: react-native-web'de native sürücü yok,
      // true verilirse dönüş hiç uygulanmıyor (sessizce).
      Animated.timing(spin, {
        toValue: 1,
        duration: 600,
        easing: Easing.linear,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (cancelled || !finished) return;
        if (loadingRef.current) runTurn();
        else {
          spin.setValue(0);
          setSpinning(false);
        }
      });
    };

    runTurn();
    return () => {
      cancelled = true;
      spin.setValue(0);
    };
  }, [spinning, spin]);

  const handlePress = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setSpinning(true);
    try {
      await onPress();
    } finally {
      // Dönüşü BURADA durdurmuyoruz - animasyon, içinde bulunduğu turu
      // tamamlayıp kendi duruyor. Böylece ikon veri gelmeden önce asla
      // durmaz ve yarım açıda kalmaz.
      loadingRef.current = false;
    }
  };

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel="Yenile"
      accessibilityState={{ busy: spinning }}
      style={[
        styles.floatingRefreshBtn,
        { top: insetsTop + 8, backgroundColor: t.surface, borderColor: t.border },
      ]}>
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Ionicons name="refresh" size={18} color={t.accent} />
      </Animated.View>
    </Pressable>
  );
}

type ServerStatusInfo = { state: string; lastError?: string };

/**
 * Sunucu 3 otomatik deneme sonunda da toparlanamayıp 'failed' durumuna
 * düşünce (bkz. electron/main/server.ts scheduleRetryOrFail) hem burada bir
 * toast hem de (main süreçten, aynı anda) bir native OS bildirimi gösterilir
 * - aynı mesajı iki kanaldan: pencere arka planda/başka sekmedeyken native
 * bildirim, pencere önde ve açıkken de uygulama içi toast fark edilsin diye.
 * Hangi sekme açık olursa olsun görünsün diye Shell kökünde, sekme
 * içeriğinin DIŞINDA monte edilir.
 */
function ServerFailureToast() {
  const { theme: t } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.desktop) return;
    return window.desktop.server.onStatusChange((status: ServerStatusInfo) => {
      if (status.state === 'failed' && status.lastError) {
        setMessage(status.lastError);
      }
    });
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;

  return (
    <View pointerEvents="box-none" style={[styles.toastWrap, { top: insets.top + 8 }]}>
      <View style={[styles.toast, { backgroundColor: t.toastBg, borderColor: t.border }]}>
        <View style={[styles.toastIcon, { backgroundColor: t.helperWarn }]}>
          <Ionicons name="alert" size={14} color={t.onAccent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.toastTitle, { color: t.toastText }]}>Sunucu durdu</Text>
          <Text numberOfLines={2} style={[styles.toastSub, { color: t.toastSub }]}>
            {message}
          </Text>
        </View>
        <Pressable onPress={() => setMessage(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Kapat">
          <Ionicons name="close" size={16} color={t.toastSub} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * "Sunucuya ulaşılamıyor, tekrar deneniyor…" bandı.
 *
 * Ana süreç bir isteği yeniden denerken 'client:retry' yayınlıyor ve preload
 * bunu renderer'a açıyordu — ama bu sinyale ABONE OLAN tek yer mobile-app'in
 * device-context'iydi ve onun bandı yalnızca Aktarım sekmesinde çiziliyor.
 * Bildirimler, Dosyalar ve Sunucu sekmelerinde kullanıcı yeniden deneme
 * boyunca (~5 sn, uzak sunucuda ~29 sn) hiçbir geri bildirim almadan
 * bekliyordu. Bu bileşen o boşluğu kapatıyor.
 *
 * Aktarım'da BİLEREK çizilmiyor: orada ekranın kendi bandı zaten var, ikisi
 * birlikte üst üste binerdi.
 */
function ClientRetryBanner({ visible }: { visible: boolean }) {
  const { theme: t } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [info, setInfo] = useState<{ attempt: number; maxAttempts: number } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.desktop) return;
    return window.desktop.client.onRetry(setInfo);
  }, []);

  // Yeniden deneme dizisi bittiğinde sinyal gelmiyor (yalnızca "deniyorum"
  // yayınlanıyor), bu yüzden bandı kendi kendine kapatıyoruz. Süre bir
  // denemeler-arası aralıktan (2,5 sn) rahatça uzun.
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(() => setInfo(null), 4000);
    return () => clearTimeout(timer);
  }, [info]);

  if (!visible || !info) return null;

  return (
    <View pointerEvents="none" style={[styles.toastWrap, { top: insets.top + 8 }]}>
      <View style={[styles.retryBanner, { backgroundColor: t.rowBgSel, borderColor: t.helperWarn }]}>
        <Ionicons name="cloud-offline-outline" size={15} color={t.helperWarn} />
        <Text style={[styles.retryText, { color: t.helperWarn }]}>
          Sunucuya ulaşılamıyor, tekrar deneniyor ({info.attempt}/{info.maxAttempts})…
        </Text>
      </View>
    </View>
  );
}

function Shell() {
  const { theme: t } = useAppTheme();
  const { refresh: refreshDevices } = useDevices();
  const [activeTab, setActiveTab] = useState<TabKey>('bildirimler');
  // Bildirimler ekranının kendi tazeleme fonksiyonu: yenile tuşu hem cihaz
  // listesini hem bildirim listesini bekleyebilsin diye ekran tarafından
  // buraya kaydediliyor.
  const bildirimlerReloadRef = useRef<(() => Promise<void>) | null>(null);
  const registerBildirimlerReload = useCallback((reload: () => Promise<void>) => {
    bildirimlerReloadRef.current = reload;
  }, []);
  const overlayPath = useOverlayPath();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={styles.body}>
        <View style={[styles.sidebar, { backgroundColor: t.surface, borderRightColor: t.border }]}>
          <Text style={[styles.brand, { color: t.accent }]}>deneme</Text>
          {TABS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.tabBtn, { backgroundColor: active ? t.rowBgSel : 'transparent' }]}>
                <Ionicons name={tab.icon} size={20} color={active ? t.accent : t.muted} />
                <Text style={[styles.tabLabel, { color: active ? t.accent : t.muted, fontWeight: active ? '800' : '600' }]}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.screenArea}>
          <ErrorBoundary key={activeTab} screenLabel={TABS.find((tb) => tb.key === activeTab)?.label ?? 'Ekran'}>
            {activeTab === 'bildirimler' && <BildirimlerScreen registerReload={registerBildirimlerReload} />}
            {activeTab === 'dosyalar' && <DosyalarScreen />}
            {activeTab === 'aktarim' && <AktarimScreen />}
            {activeTab === 'sunucu' && <SunucuScreen />}
          </ErrorBoundary>

          {activeTab === 'bildirimler' && (
            <FloatingRefreshButton
              insetsTop={insets.top}
              onPress={async () => {
                // Dönüş, İKİ verinin de gelmesini bekliyor: cihaz listesi ve
                // bildirim listesi. Eskiden yalnızca cihazlar bekleniyordu.
                await Promise.all([refreshDevices(), bildirimlerReloadRef.current?.() ?? Promise.resolve()]);
              }}
            />
          )}
          {activeTab === 'aktarim' && <FloatingRefreshButton insetsTop={insets.top} onPress={refreshDevices} />}
        </View>
      </View>

      {overlayPath && (
        <View style={[styles.overlay, { backgroundColor: t.scrim }]}>
          <View style={[styles.overlayCard, { backgroundColor: t.bg }]}>
            {overlayPath === '/pair-device' && <PairDeviceScreen />}
            {overlayPath === '/server-settings' && <ServerSettingsScreen />}
          </View>
        </View>
      )}

      <ClientRetryBanner visible={activeTab !== 'aktarim'} />
      <ServerFailureToast />
    </View>
  );
}

export function AppRoot() {
  return (
    <SafeAreaProvider>
      <ThemeModeProvider>
        <DeviceProvider>
          <Shell />
        </DeviceProvider>
      </ThemeModeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 180, borderRightWidth: 1, paddingTop: 24, paddingHorizontal: 10, gap: 4 },
  brand: { fontSize: 18, fontWeight: '800', paddingHorizontal: 10, marginBottom: 18 },
  tabBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 10, borderRadius: 12 },
  tabLabel: { fontSize: 13 },
  screenArea: { flex: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  overlayCard: { width: 460, maxWidth: '90%', height: 520, maxHeight: '85%', borderRadius: 20, overflow: 'hidden' },
  floatingRefreshBtn: {
    position: 'absolute',
    right: 66,
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 50 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 15,
    paddingVertical: 13,
    width: 420,
    maxWidth: '90%',
  },
  retryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: '90%',
  },
  retryText: { fontSize: 12, fontWeight: '700' },
  toastIcon: { width: 26, height: 26, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  toastTitle: { fontSize: 13, fontWeight: '700' },
  toastSub: { fontSize: 11, fontWeight: '500', marginTop: 1 },
});
