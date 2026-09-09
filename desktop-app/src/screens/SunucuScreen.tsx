import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/contexts/theme-context';
import Ionicons from '@expo/vector-icons/Ionicons';

type DeviceRow = { deviceId: string; name: string; pairedAt: string; lastSeenAt: string | null; connected: boolean };
type ServerLifecycleState = 'stopped' | 'stopping' | 'starting' | 'running' | 'retrying' | 'failed';
type ServerStatus = {
  state: ServerLifecycleState;
  running: boolean;
  host?: string;
  port?: number;
  retryAttempt?: number;
  maxRetries?: number;
  lastError?: string;
};
type PairResult = { deviceId: string; name: string; token: string; pairedAt: string };
type NetworkAddress = { url: string; ip: string; kind: 'tailscale' | 'lan'; interfaceName: string };
type NetworkInfo = { hostName: string; addresses: NetworkAddress[] };
type MessageRow = { id: string; fileName: string; note: string; uploadedBy: string | null; uploadedAt: string };

function statusLabel(status: ServerStatus): string {
  switch (status.state) {
    case 'running':
      return `Çalışıyor: ${status.host}:${status.port}`;
    case 'starting':
      return 'Başlatılıyor…';
    case 'stopping':
      return 'Durduruluyor…';
    case 'retrying':
      return `Yeniden deneniyor (${status.retryAttempt}/${status.maxRetries})…`;
    case 'failed':
      return 'Durdu — manuel yeniden başlatma gerekiyor';
    default:
      return 'Durduruldu';
  }
}

/**
 * Mobilde karşılığı olmayan, yeni bir ekran — mobile-app'in sekmelerinin
 * YANINA eklendi (onları değiştirmeden). Aynı tasarım dilini (kart/renk/
 * boşluk token'ları, `contexts/theme-context`) kullanıyor ama sıfırdan
 * yazıldı, react-native-web üzerinden yeniden kullanılan bir mobil ekran
 * değil.
 */
export default function SunucuScreen() {
  const insets = useSafeAreaInsets();
  const { dark, toggleTheme, theme: t } = useAppTheme();

  const [storageRoot, setStorageRoot] = useState<string | null>(null);
  const [port, setPort] = useState('4000');
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoStartServer, setAutoStartServer] = useState(true);
  const [status, setStatus] = useState<ServerStatus>({ state: 'stopped', running: false });
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [removingMessageId, setRemovingMessageId] = useState<string | null>(null);
  /** Cihaz/mesaj silme gibi işlemlerin hata sonucu - eskiden yutuluyordu. */
  const [rowError, setRowError] = useState<string | null>(null);

  // react-native-web'in ref instance tipleri react-native'inkiyle birebir
  // örtüşmüyor; burada yalnızca FİİLEN çağırdığımız iki metodu tiplemek hem
  // yeterli hem de niyeti açıkça gösteriyor.
  const scrollRef = useRef<{ scrollToEnd: (opts?: { animated?: boolean }) => void } | null>(null);
  const pairNameRef = useRef<{ focus: () => void } | null>(null);

  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairName, setPairName] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairResult, setPairResult] = useState<PairResult | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Hangi şeyin kopyalandığı: kod mu, adres mi. */
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);

  // Önceki oturumda gerçek Electron ortamında (paketlenmiş .exe) bu ekranın
  // "Cannot read properties of undefined (reading 'settings')" ile çöktüğü
  // bildirildi. Kök neden bulunup düzeltildi (electron-builder'ın npm "file:"
  // bağımlılıklarını asar'a paketlerken symlink'i doğru izlememesi -
  // deneme-server paketlenmiş uygulamada eksik kalıyordu, bkz. oturum sonu
  // raporu) - ama bu ekranın window.desktop'a SENKRON erişmesi (useEffect
  // içinde, promise zinciri olmadan) tek başına kırılgan bir tasarımdı;
  // preload herhangi bir nedenle yüklenemezse (paketleme hatası, gelecekte
  // başka bir regresyon) diğer üç sekme (services/api.ts üzerinden, hepsi
  // Promise .catch()'e düşüyor) zarifçe "Sunucuya ulaşılamıyor" gösterirken
  // bu ekran SESSİZCE ErrorBoundary'ye düşüyordu. Şimdi aynı zarif
  // davranışı burada da sağlıyoruz.
  const [bridgeMissing, setBridgeMissing] = useState(false);

  const refreshDevices = () => {
    setDevicesLoading(true);
    window.desktop.server
      .listDevices()
      .then((list: DeviceRow[]) => setDevices(list))
      // .catch şart: IPC reddederse yakalanmamış promise reddi oluşuyordu
      // ve kullanıcı hiçbir hata görmüyordu.
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false));
  };

  const refreshMessages = () => {
    setMessagesLoading(true);
    window.desktop.server
      .listMessages()
      .then((list: MessageRow[]) => {
        setMessages(list);
        setMessagesError(null);
      })
      // Depo klasörü erişilemez olduğunda sunucu artık 503 veriyor; bunu
      // sessizce boş listeye çevirmek kullanıcıya "mesajların silinmiş"
      // izlenimi veriyordu.
      .catch(() => setMessagesError('Mesajlar okunamadı — depo klasörüne erişilemiyor olabilir'))
      .finally(() => setMessagesLoading(false));
  };

  // Yenile butonu VE ilk yükleme aynı fonksiyonu kullanıyor - "bağlı cihaz
  // listesini ve sunucu çalışma durumunu yeniden çeksin" (görev tanımı).
  // Mesajlar da aynı butona bağlandı - mantıksal olarak aynı "sunucu
  // durumunu tazele" eylemi.
  // Adres, port ayarına bağlı olduğundan durum/port her değiştiğinde tazeleniyor.
  const refreshNetwork = () => {
    window.desktop.server
      .networkInfo()
      .then(setNetwork)
      .catch(() => setNetwork(null));
  };

  const refreshAll = () => {
    window.desktop.server.status().then(setStatus).catch(() => {});
    refreshDevices();
    refreshMessages();
    refreshNetwork();
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.desktop) {
      setBridgeMissing(true);
      return;
    }
    window.desktop.settings
      .get()
      .then((s: { storageRoot: string | null; port: number; autoLaunch: boolean; autoStartServer: boolean }) => {
        setStorageRoot(s.storageRoot);
        setPort(String(s.port));
        setAutoLaunch(s.autoLaunch);
        setAutoStartServer(s.autoStartServer);
      })
      // .catch şart: IPC reddederse yakalanmamış promise reddi oluşuyordu.
      .catch(() => setStartError('Ayarlar okunamadı'));
    refreshAll();

    const unsubscribe = window.desktop.server.onStatusChange((s: ServerStatus) => {
      setStatus(s);
      refreshDevices();
      refreshNetwork();
    });
    return unsubscribe;
  }, []);

  // --- Masaüstünün kendi istemci eşleştirmesi ---
  const [selfPaired, setSelfPaired] = useState(true);
  const [selfPairing, setSelfPairing] = useState(false);
  const [selfPairError, setSelfPairError] = useState<string | null>(null);

  /**
   * "Eşleşmiş mi" sorusunun doğru cevabı kimlik bilgisinin VARLIĞI değil,
   * GEÇERLİLİĞİ.
   *
   * Eskiden yalnızca `getCredentials() !== null` bakılıyordu. Kullanıcı
   * "bu bilgisayar" cihazını çıkardığında (ya da tokens.json sıfırlandığında)
   * kimlik bilgisi diskte DURUYOR ama sunucuda geçersiz oluyor: Dosyalar ve
   * Aktarım sonsuza kadar 401 veriyor, "Bu bilgisayarı kendi sunucusuna
   * eşleştir" kartı ise kimlik bilgisi var göründüğü için HİÇ çıkmıyordu.
   * Arayüzden çıkışı olmayan bir çıkmazdı.
   *
   * Yalnızca 401 "geçersiz" sayılır; sunucuya ulaşılamaması (status 0)
   * kimlik bilgisi hakkında hiçbir şey söylemez, o durumda dokunmuyoruz.
   */
  const refreshSelfPairedStrict = useCallback(async () => {
    if (typeof window === 'undefined' || !window.desktop) return;
    try {
      const creds = await window.desktop.client.getCredentials();
      if (!creds) {
        setSelfPaired(false);
        return;
      }
      const probe = await window.desktop.client.request('GET', '/api/devices');
      if (probe.status === 401) {
        await window.desktop.client.clearCredentials();
        setSelfPaired(false);
        return;
      }
      setSelfPaired(true);
    } catch {
      // Ağ/IPC hatası kimlik bilgisi hakkında bir kanıt değil - durumu koru.
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.desktop) return;
    void refreshSelfPairedStrict();
  }, [refreshSelfPairedStrict]);

  const pairWithOwnServer = async () => {
    setSelfPairing(true);
    setSelfPairError(null);
    try {
      const result = await window.desktop.client.pairWithOwnServer();
      if (!result.ok) setSelfPairError(result.error ?? 'Eşleştirme başarısız oldu');
      else {
        await refreshSelfPairedStrict();
        refreshDevices();
      }
    } catch (e) {
      setSelfPairError(e instanceof Error ? e.message : 'Eşleştirme başarısız oldu');
    } finally {
      setSelfPairing(false);
    }
  };

  // "Kopyalandı" durumu kendiliğinden geri dönsün: eskiden yalnızca
  // eşleştirme penceresi yeniden açıldığında sıfırlanıyordu, dolayısıyla
  // ikinci bir kopyalamanın işe yarayıp yaramadığı anlaşılmıyordu.
  // KONUM ÖNEMLİ: aşağıdaki erken return'den ÖNCE olmalı, yoksa koşullu
  // hook olur.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!copiedAddress) return;
    const timer = setTimeout(() => setCopiedAddress(false), 2000);
    return () => clearTimeout(timer);
  }, [copiedAddress]);

  if (bridgeMissing) {
    return (
      <View style={[styles.screen, styles.bridgeMissingScreen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
        <Ionicons name="alert-circle-outline" size={28} color={t.helperWarn} />
        <Text style={[styles.cardValue, { color: t.text, marginTop: 12 }]}>Masaüstü köprüsü yüklenemedi</Text>
        <Text style={[styles.hintText, { color: t.muted, textAlign: 'center', marginTop: 6, maxWidth: 320 }]}>
          Uygulamayı kapatıp yeniden aç. Sorun devam ederse uygulamayı yeniden kur.
        </Text>
      </View>
    );
  }

  const pickStorageFolder = async () => {
    // try/catch şart: IPC reddederse yakalanmamış promise reddi oluşuyordu.
    try {
      const folder = await window.desktop.settings.pickStorageFolder();
      if (folder) setStorageRoot(folder);
    } catch {
      setStartError('Klasör seçilemedi');
    }
  };

  const savePort = (value: string) => {
    const digitsOnly = value.replace(/[^0-9]/g, '').slice(0, 5);
    setPort(digitsOnly);
    const parsed = Number(digitsOnly);
    if (digitsOnly && parsed > 0 && parsed < 65536) {
      window.desktop.settings
        .setPort(parsed)
        // Gösterilen adres portu içeriyor - port değişince tazelenmeli,
        // yoksa kullanıcı telefona eski portu yazar.
        .then(() => refreshNetwork())
        .catch(() => setStartError('Port kaydedilemedi'));
    }
  };

  const toggleAutoLaunch = () => {
    const next = !autoLaunch;
    setAutoLaunch(next);
    window.desktop.settings.setAutoLaunch(next);
  };

  const toggleAutoStartServer = () => {
    const next = !autoStartServer;
    setAutoStartServer(next);
    window.desktop.settings.setAutoStartServer(next);
  };

  const toggleServer = async () => {
    setStartError(null);
    if (status.running) {
      // try/catch + gösterge şart: kapanış anlık değil (açık bağlantılar
      // bitene kadar sürebiliyor) ve eskiden bu bekleyiş sırasında tuş
      // normal görünmeye devam ediyordu.
      setStopping(true);
      try {
        await window.desktop.server.stop();
        setStatus(await window.desktop.server.status());
      } catch (e) {
        setStartError(e instanceof Error ? e.message : 'Sunucu durdurulamadı');
      } finally {
        setStopping(false);
      }
      return;
    }
    setStarting(true);
    // try/finally: IPC reddederse starting true kalıyor ve tuş uygulama
    // yeniden başlatılana kadar devre dışı kalıyordu.
    try {
      const result = await window.desktop.server.start();
      if (!result.ok) setStartError(result.error ?? 'Sunucu başlatılamadı');
      setStatus(await window.desktop.server.status());
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Sunucu başlatılamadı');
    } finally {
      setStarting(false);
    }
  };

  const handleRestart = async () => {
    setStartError(null);
    setRestarting(true);
    try {
      const result = await window.desktop.server.restart();
      if (!result.ok) setStartError(result.error ?? 'Sunucu yeniden başlatılamadı');
      setStatus(await window.desktop.server.status());
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Sunucu yeniden başlatılamadı');
    } finally {
      setRestarting(false);
    }
  };

  // react-native-web'de Alert.alert() TAMAMEN NO-OP (node_modules/react-native-web/
  // dist/exports/Alert/index.js: "static alert() {}") - kaynağı okunarak
  // doğrulandı. window.confirm() Electron renderer'ında (gerçek Chromium)
  // güvenilir çalışıyor - "basit bir confirm dialog" isteği için yeterli.
  // Aşağıdaki ikisinde de try/finally şart: IPC reddederse "çıkarılıyor"
  // göstergesi ilgili satırda kalıcı olarak asılı kalıyordu.
  // Dönen {ok,error} sonucu artık OKUNUYOR: eskiden yok sayılıyordu, bu yüzden
  // silinemeyen bir cihaz/mesaj kullanıcıya "silinmiş gibi" görünüyordu.
  const handleRemoveDevice = async (device: DeviceRow) => {
    if (!window.confirm(`"${device.name}" sistemden çıkarılacak. Emin misin?`)) return;
    setRemovingId(device.deviceId);
    setRowError(null);
    try {
      const result = await window.desktop.server.removeDevice(device.deviceId);
      if (!result.ok) setRowError(result.error ?? 'Cihaz çıkarılamadı');
      refreshDevices();
      // Çıkarılan cihaz bu bilgisayarın kendisiyse saklanan kimlik bilgisi
      // artık geçersiz; temizlenmezse Dosyalar/Aktarım kalıcı 401'e düşüyor
      // ve yeniden eşleştirme kartı da (kimlik bilgisi "var" göründüğü için)
      // gizli kalıyordu.
      await refreshSelfPairedStrict();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'Cihaz çıkarılamadı');
    } finally {
      setRemovingId(null);
    }
  };

  const handleRemoveMessage = async (message: MessageRow) => {
    if (!window.confirm('Bu mesaj kalıcı olarak silinecek. Emin misin?')) return;
    setRemovingMessageId(message.id);
    setRowError(null);
    try {
      const result = await window.desktop.server.removeMessage(message.id);
      if (!result.ok) setRowError(result.error ?? 'Mesaj silinemedi');
      refreshMessages();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'Mesaj silinemedi');
    } finally {
      setRemovingMessageId(null);
    }
  };

  function deviceNameFor(deviceId: string | null): string {
    if (!deviceId) return 'Bilinmeyen cihaz';
    return devices.find((d) => d.deviceId === deviceId)?.name ?? 'Bilinmeyen cihaz';
  }

  /**
   * Kart, uzun bir sayfanın EN ALTINA ekleniyor (cihaz ve mesaj listelerinin
   * ardından). "+" tuşuna basıldığında ekranda görünür hiçbir şey değişmediği
   * için kullanıcı alana yazamıyor sanıyordu — kart görüş alanının dışındaydı
   * ve alan odaklanmamış oluyordu. Artık kart açılır açılmaz sona kaydırılıyor
   * ve alan doğrudan odaklanıyor; kullanıcı hemen yazmaya başlayabiliyor.
   *
   * requestAnimationFrame: React kartı DOM'a bastıktan SONRA kaydırmak ve
   * odaklamak gerekiyor, aksi hâlde ref henüz boş.
   */
  const openPairing = () => {
    setPairingOpen(true);
    setPairName('');
    setPairResult(null);
    setPairError(null);
    setCopied(false);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
      requestAnimationFrame(() => pairNameRef.current?.focus());
    });
  };

  const submitPairing = async () => {
    const trimmed = pairName.trim();
    if (!trimmed) return;
    setPairing(true);
    setPairError(null);
    try {
      const result = await window.desktop.server.pairDevice(trimmed);
      setPairResult(result);
      refreshDevices();
    } catch (e) {
      setPairError(e instanceof Error ? e.message : 'Eşleştirme başarısız oldu');
    } finally {
      setPairing(false);
    }
  };

  const copyAddress = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedAddress(true);
    } catch {
      setPairError('Panoya kopyalanamadı, adresi elle seçip kopyala');
    }
  };

  const copyPairResult = async () => {
    if (!pairResult) return;
    const payload = JSON.stringify({ deviceId: pairResult.deviceId, token: pairResult.token });
    try {
      // writeText odak/izin sorunlarında reddedebiliyor; catch olmadan
      // kullanıcı "Kopyalandı" görmüyor ama hata da hiçbir yere düşmüyordu -
      // token kopyalandı sanılıp yapıştırılamıyordu.
      await navigator.clipboard.writeText(payload);
      setCopied(true);
    } catch {
      setPairError('Panoya kopyalanamadı, kodu elle seçip kopyala');
    }
  };


  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Sunucu</Text>
          <Text style={[styles.subtitle, { color: t.accent }]}>Bu bilgisayarı dosya sunucusu yap</Text>
        </View>
        <View style={styles.headerBtns}>
          <Pressable
            onPress={refreshAll}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Yenile"
            style={[styles.themeBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Ionicons name="refresh" size={18} color={t.accent} />
          </Pressable>
          <Pressable
            onPress={toggleTheme}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={dark ? 'Açık temaya geç' : 'Koyu temaya geç'}
            style={[styles.themeBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Ionicons name={dark ? 'moon' : 'sunny'} size={18} color={t.accent} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        ref={(node) => {
          scrollRef.current = node as unknown as { scrollToEnd: (opts?: { animated?: boolean }) => void } | null;
        }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[styles.cardLabel, { color: t.muted }]}>DEPO KLASÖRÜ</Text>
          <Text numberOfLines={1} style={[styles.cardValue, { color: t.text }]}>
            {storageRoot ?? 'Henüz seçilmedi'}
          </Text>
          <Pressable
            onPress={pickStorageFolder}
            accessibilityRole="button"
            accessibilityLabel="Depo klasörü seç"
            style={[styles.smallBtn, { borderColor: t.accent }]}>
            <Text style={[styles.smallBtnLabel, { color: t.accent }]}>{storageRoot ? 'Değiştir' : 'Klasör Seç'}</Text>
          </Pressable>
        </View>

        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[styles.cardLabel, { color: t.muted }]}>PORT</Text>
          <TextInput
            value={port}
            onChangeText={savePort}
            editable={!status.running}
            keyboardType="number-pad"
            accessibilityLabel="Port"
            style={[styles.portInput, { color: t.text, borderColor: t.border, backgroundColor: t.inputBg }]}
          />
          {status.running && (
            <Text style={[styles.hintText, { color: t.dim }]}>Port değiştirmek için önce sunucuyu durdur</Text>
          )}
        </View>

        <View
          style={[
            styles.statusCard,
            { backgroundColor: t.surface, borderColor: status.state === 'running' ? t.accent : t.border },
          ]}>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: status.state === 'running' ? t.accent : status.state === 'failed' ? t.helperWarn : t.checkOff },
              ]}
            />
            <Text style={[styles.statusText, { color: t.text }]}>{statusLabel(status)}</Text>
          </View>
          <View style={styles.serverBtnRow}>
            <Pressable
              onPress={toggleServer}
              disabled={starting || stopping || restarting}
              accessibilityRole="button"
              accessibilityLabel={status.running ? 'Sunucuyu durdur' : 'Sunucuyu başlat'}
              style={[styles.toggleBtn, { flex: 1, backgroundColor: status.running ? t.helperWarn : t.accent }]}>
              {starting || stopping ? (
                <ActivityIndicator size="small" color={t.onAccent} />
              ) : (
                <Text style={[styles.toggleBtnLabel, { color: t.onAccent }]}>{status.running ? 'Durdur' : 'Başlat'}</Text>
              )}
            </Pressable>
            <Pressable
              onPress={handleRestart}
              disabled={starting || stopping || restarting}
              accessibilityRole="button"
              accessibilityLabel="Sunucuyu yeniden başlat"
              style={[styles.restartBtn, { borderColor: t.accent }]}>
              {restarting ? (
                <ActivityIndicator size="small" color={t.accent} />
              ) : (
                <Ionicons name="refresh-circle-outline" size={22} color={t.accent} />
              )}
            </Pressable>
          </View>
          {(startError ?? (status.state === 'failed' ? status.lastError : undefined)) && (
            <Text style={[styles.errorText, { color: t.helperWarn }]}>
              {startError ?? status.lastError}
            </Text>
          )}
          {rowError ? <Text style={[styles.errorText, { color: t.helperWarn }]}>{rowError}</Text> : null}
        </View>

        <Pressable onPress={toggleAutoLaunch} style={styles.autoLaunchRow} accessibilityRole="checkbox" accessibilityState={{ checked: autoLaunch }}>
          <View
            style={[
              styles.checkbox,
              { borderColor: autoLaunch ? t.accent : t.border, backgroundColor: autoLaunch ? t.accent : 'transparent' },
            ]}>
            {autoLaunch && <Ionicons name="checkmark" size={14} color={t.onAccent} />}
          </View>
          <Text style={[styles.autoLaunchLabel, { color: t.text }]}>Windows açılışında otomatik başlat</Text>
        </Pressable>

        <Pressable
          onPress={toggleAutoStartServer}
          style={styles.autoLaunchRow}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: autoStartServer }}>
          <View
            style={[
              styles.checkbox,
              {
                borderColor: autoStartServer ? t.accent : t.border,
                backgroundColor: autoStartServer ? t.accent : 'transparent',
              },
            ]}>
            {autoStartServer && <Ionicons name="checkmark" size={14} color={t.onAccent} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.autoLaunchLabel, { color: t.text }]}>Uygulama açılınca sunucuyu otomatik başlat</Text>
            <Text style={[styles.hintText, { color: t.muted, marginTop: 2 }]}>
              Windows'u değil, yalnızca bu uygulamanın kendi sunucusunu etkiler
            </Text>
          </View>
        </Pressable>

        <View style={styles.deviceSectionHeader}>
          <Text style={[styles.sectionLabel, { color: t.muted }]}>EŞLEŞTİRİLMİŞ CİHAZLAR</Text>
          <Pressable
            onPress={openPairing}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Yeni cihaz ekle"
            style={[styles.addDeviceBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Ionicons name="add" size={16} color={t.accent} />
          </Pressable>
        </View>

        {/* Masaüstünün KENDİ istemci rolü (Dosyalar/Aktarım/Bildirimler
            sekmeleri) ayrı bir eşleştirme istiyor. Öncesinde bunun için
            buradan bir eşleştirme üretip, çıkan JSON'u aynı uygulamaya elle
            yapıştırmak gerekiyordu. */}
        {!selfPaired && (
          <Pressable
            onPress={pairWithOwnServer}
            disabled={selfPairing}
            accessibilityRole="button"
            accessibilityLabel="Bu bilgisayarı kendi sunucusuna eşleştir"
            style={[styles.selfPairCard, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Ionicons name="link-outline" size={16} color={t.accent} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardValue, { color: t.text }]}>
                {selfPairing ? 'Eşleştiriliyor…' : 'Bu bilgisayarı kendi sunucusuna eşleştir'}
              </Text>
              <Text style={[styles.hintText, { color: t.muted, marginTop: 2 }]}>
                Dosyalar ve Aktarım sekmelerinin çalışması için gerekli
              </Text>
            </View>
          </Pressable>
        )}
        {selfPairError ? (
          <Text style={[styles.hintText, { color: t.helperWarn }]}>{selfPairError}</Text>
        ) : null}

        {devicesLoading && devices.length === 0 && <Text style={[styles.hintText, { color: t.muted }]}>Yükleniyor…</Text>}
        {!devicesLoading && devices.length === 0 && (
          <Text style={[styles.hintText, { color: t.muted }]}>Henüz eşleştirilmiş cihaz yok</Text>
        )}
        {devices.map((d) => (
          <View key={d.deviceId} style={[styles.deviceRow, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Ionicons name="desktop-outline" size={18} color={t.text} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.deviceName, { color: t.text }]}>
                {d.name}
              </Text>
              <View style={styles.deviceStatusRow}>
                <View style={[styles.dot, { backgroundColor: d.connected ? t.accent : t.checkOff }]} />
                <Text style={[styles.deviceMeta, { color: t.muted }]}>{d.connected ? 'Bağlı' : 'Bağlı değil'}</Text>
              </View>
            </View>
            <Pressable
              onPress={() => handleRemoveDevice(d)}
              disabled={removingId === d.deviceId}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`${d.name} cihazını çıkar`}>
              {removingId === d.deviceId ? (
                <ActivityIndicator size="small" color={t.muted} />
              ) : (
                <Ionicons name="close-circle-outline" size={18} color={t.helperWarn} />
              )}
            </Pressable>
          </View>
        ))}

        <View style={styles.deviceSectionHeader}>
          <Text style={[styles.sectionLabel, { color: t.muted }]}>MESAJLAR</Text>
        </View>

        {messagesLoading && messages.length === 0 && (
          <Text style={[styles.hintText, { color: t.muted }]}>Yükleniyor…</Text>
        )}
        {messagesError ? (
          <Text style={[styles.errorText, { color: t.helperWarn }]}>{messagesError}</Text>
        ) : (
          !messagesLoading &&
          messages.length === 0 && <Text style={[styles.hintText, { color: t.muted }]}>Henüz mesaj yok</Text>
        )}
        {messages.map((m) => (
          <View key={m.id} style={[styles.messageRow, { backgroundColor: t.surface, borderColor: t.border }]}>
            <View style={[styles.messageIcon, { backgroundColor: t.accentSoft }]}>
              <Ionicons name="chatbubble-outline" size={16} color={t.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.messageText, { color: t.text }]}>{m.note}</Text>
              <Text style={[styles.messageMeta, { color: t.muted }]}>
                {deviceNameFor(m.uploadedBy)} · {new Date(m.uploadedAt).toLocaleString('tr-TR')}
              </Text>
            </View>
            <Pressable
              onPress={() => handleRemoveMessage(m)}
              disabled={removingMessageId === m.id}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Mesajı sil">
              {removingMessageId === m.id ? (
                <ActivityIndicator size="small" color={t.muted} />
              ) : (
                <Ionicons name="trash-outline" size={18} color={t.helperWarn} />
              )}
            </Pressable>
          </View>
        ))}

        {pairingOpen && (
          <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Text style={[styles.cardLabel, { color: t.muted }]}>YENİ CİHAZ EKLE</Text>

            {/* Eşleştirme kodu ADRESİ taşımıyor - telefona ayrıca girilmesi
                gerekiyor ve kullanıcı bu adresi bulmak için Tailscale
                arayüzüne bakmak zorundaydı. Artık burada yazıyor. */}
            {network && network.addresses.length > 0 ? (
              <View style={[styles.addressBox, { borderColor: t.border, backgroundColor: t.inputBg }]}>
                <Text style={[styles.hintText, { color: t.muted }]}>
                  Bu bilgisayar: {network.hostName}
                </Text>
                {network.addresses.map((a) => (
                  <View key={a.ip} style={styles.addressRow}>
                    <View
                      style={[
                        styles.addressTag,
                        { backgroundColor: a.kind === 'tailscale' ? t.accentSoft : 'transparent', borderColor: t.border },
                      ]}>
                      <Text style={[styles.addressTagLabel, { color: a.kind === 'tailscale' ? t.accent : t.dim }]}>
                        {a.kind === 'tailscale' ? 'Tailscale' : 'Yerel ağ'}
                      </Text>
                    </View>
                    <Text selectable style={[styles.addressUrl, { color: t.text }]}>
                      {a.url}
                    </Text>
                    <Pressable
                      onPress={() => copyAddress(a.url)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`${a.url} adresini kopyala`}>
                      <Ionicons name="copy-outline" size={15} color={t.accent} />
                    </Pressable>
                  </View>
                ))}
                <Text style={[styles.hintText, { color: t.dim }]}>
                  {copiedAddress
                    ? 'Adres kopyalandı'
                    : network.addresses[0].kind === 'tailscale'
                      ? 'Telefonda “Sunucu Adresi” alanına bu adresi yaz — her ağdan çalışır.'
                      : 'Tailscale adresi bulunamadı; yerel ağ adresi yalnızca aynı Wi-Fi’da çalışır.'}
                </Text>
              </View>
            ) : (
              <Text style={[styles.hintText, { color: t.dim }]}>
                Ağ adresi bulunamadı — Tailscale kapalı olabilir.
              </Text>
            )}

            {!pairResult ? (
              <>
                <TextInput
                  ref={(node) => {
                    pairNameRef.current = node as unknown as { focus: () => void } | null;
                  }}
                  value={pairName}
                  onChangeText={setPairName}
                  onSubmitEditing={submitPairing}
                  autoFocus
                  placeholder="Cihaz adı (ör. mutfak telefonu)"
                  placeholderTextColor={t.dim}
                  accessibilityLabel="Cihaz adı"
                  style={[styles.portInput, { color: t.text, borderColor: t.border, backgroundColor: t.inputBg }]}
                />
                {pairError && <Text style={[styles.errorText, { color: t.helperWarn }]}>{pairError}</Text>}
                <Pressable
                  onPress={submitPairing}
                  disabled={!pairName.trim() || pairing}
                  accessibilityRole="button"
                  accessibilityLabel="Cihazı eşleştir"
                  style={[styles.smallBtn, { borderColor: t.accent, alignSelf: 'flex-start' }]}>
                  {pairing ? (
                    <ActivityIndicator size="small" color={t.accent} />
                  ) : (
                    <Text style={[styles.smallBtnLabel, { color: t.accent }]}>Oluştur</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Text style={[styles.hintText, { color: t.muted }]}>
                  Aşağıdaki kodu diğer cihazda (Aktarım sekmesi → Cihaz Ekle) yapıştır. Token yalnızca burada gösteriliyor.
                </Text>
                <Text selectable style={[styles.codeBox, { color: t.text, borderColor: t.border, backgroundColor: t.inputBg }]}>
                  {JSON.stringify({ deviceId: pairResult.deviceId, token: pairResult.token })}
                </Text>
                <Pressable
                  onPress={copyPairResult}
                  accessibilityRole="button"
                  accessibilityLabel="Kopyala"
                  style={[styles.smallBtn, { borderColor: t.accent, alignSelf: 'flex-start' }]}>
                  <Text style={[styles.smallBtnLabel, { color: t.accent }]}>{copied ? 'Kopyalandı' : 'Kopyala'}</Text>
                </Pressable>
              </>
            )}
            <Pressable onPress={() => setPairingOpen(false)} accessibilityRole="button" accessibilityLabel="Kapat">
              <Text style={[styles.closeLink, { color: t.muted }]}>Kapat</Text>
            </Pressable>
          </View>
        )}

        <Text style={[styles.footNote, { color: t.dim }]}>
          Pencereyi kapatmak sunucuyu durdurmaz — arka planda, sistem tepsisinden yönetilebilir şekilde çalışmaya devam
          eder. Tamamen kapatmak için tepsi menüsünden "Çıkış"ı kullan.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bridgeMissingScreen: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerBtns: { flexDirection: 'row', gap: 8 },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  themeBtn: { width: 38, height: 38, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 40, gap: 14 },
  card: { padding: 14, borderRadius: 16, borderWidth: 1, gap: 8 },
  cardLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5 },
  cardValue: { fontSize: 14, fontWeight: '700' },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 11, borderWidth: 1.5, alignItems: 'center' },
  smallBtnLabel: { fontSize: 12.5, fontWeight: '700' },
  portInput: { height: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 14, fontFamily: 'monospace' },
  hintText: { fontSize: 11.5, fontWeight: '500' },
  statusCard: { padding: 14, borderRadius: 16, borderWidth: 1.5, gap: 10 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 999 },
  statusText: { fontSize: 14, fontWeight: '800' },
  serverBtnRow: { flexDirection: 'row', gap: 10 },
  toggleBtn: { height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  toggleBtnLabel: { fontSize: 14.5, fontWeight: '800' },
  restartBtn: { width: 46, height: 46, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  errorText: { fontSize: 12, fontWeight: '700' },
  autoLaunchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  autoLaunchLabel: { fontSize: 13, fontWeight: '600' },
  deviceSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  selfPairCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  addDeviceBtn: { width: 28, height: 28, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1 },
  deviceName: { fontSize: 13, fontWeight: '700' },
  deviceStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  dot: { width: 6, height: 6, borderRadius: 999 },
  deviceMeta: { fontSize: 10.5, fontWeight: '600' },
  messageRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1 },
  messageIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  messageText: { fontSize: 13, fontWeight: '600' },
  messageMeta: { fontSize: 10.5, fontWeight: '600', marginTop: 3 },
  codeBox: { fontFamily: 'monospace', fontSize: 12, padding: 12, borderRadius: 10, borderWidth: 1 },
  addressBox: { borderWidth: 1, borderRadius: 12, padding: 11, gap: 7 },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addressTag: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 2 },
  addressTagLabel: { fontSize: 10, fontWeight: '800' },
  addressUrl: { flex: 1, fontFamily: 'monospace', fontSize: 12.5, fontWeight: '700' },
  closeLink: { fontSize: 12, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  footNote: { fontSize: 11, fontWeight: '500', lineHeight: 16, textAlign: 'center', paddingTop: 10 },
});
