import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDevices } from '@/contexts/device-context';
import { useAppTheme } from '@/contexts/theme-context';
import { ApiDevice, ping, removeDevice, uploadFiles } from '@/services/api';
import { describeError } from '@/services/error-messages';

type PickedFile = { uri: string; name: string; mimeType?: string };

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '—';
  return name.slice(dot + 1, dot + 5).toUpperCase();
}

/**
 * EKRAN DÜZENİ NOTU
 *
 * Eskiden ortada iki sonsuz "nabız halkası" animasyonu (usePulseRing) vardı;
 * tamamen dekoratifti, ekranın ortasını kaplıyor ve üst kısmı sıkıştırıyordu.
 * Ayrıca sekme görünmezken ve uygulama arka plandayken bile dönmeye devam
 * ediyordu (Animated.loop yalnızca unmount'ta durur, sekmeler ise monte kalır).
 * Kaldırıldı ve düzen yeniden dengelendi:
 *
 *   1. Durum kartı   — ne olacağını söyler, ilerleme çubuğunu taşır
 *   2. DOSYA         — asıl eylem, en görünür yerde; seçilenler artık üstte
 *   3. NOT + SUNUCU  — eski üçlü kart ikiye bölünüp aşağı alındı
 *   4. CİHAZLAR      — durum bilgisi, en aşağı alındı
 *   5. Yükle
 */
export default function AktarimScreen() {
  const insets = useSafeAreaInsets();
  const { dark, toggleTheme, theme: t } = useAppTheme();
  const {
    devices,
    loading: devicesLoading,
    error: devicesError,
    reconnecting,
    reconnectAttempt,
    refresh: refreshDevices,
    cancel: cancelDeviceRequest,
    triggerBurstCheck,
  } = useDevices();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pullRefreshing, setPullRefreshing] = useState(false);

  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  /**
   * Başarıyla gönderilenin özeti ("3 dosya" / "Not"). Seçim yükleme biter
   * bitmez temizlendiği için "Yüklendi" bildirimi artık picked'e bakamıyor.
   */
  const [sentSummary, setSentSummary] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  /**
   * Sunucu durumu. Eskiden 'checking' | 'online' | 'offline' idi ve HER hata
   * "Bağlanamıyor" sayılıyordu: cihaz sadece eşleştirilmemişken bile (sunucuya
   * hiç istek gitmemişken) kart "Bağlanamıyor" diyordu ve aynı ekrandaki "Bu
   * cihaz eşleştirilmemiş" yazısıyla çelişiyordu. Artık asıl hata saklanıyor,
   * etiketi describeError üretiyor.
   */
  const [serverChecking, setServerChecking] = useState(true);
  const [serverError, setServerError] = useState<Error | null>(null);
  const serverCheckRef = useRef(0);

  const checkServer = useCallback(() => {
    const id = ++serverCheckRef.current;
    setServerChecking(true);
    ping()
      .then(() => {
        if (id !== serverCheckRef.current) return;
        setServerError(null);
      })
      .catch((e: Error) => {
        if (id !== serverCheckRef.current) return;
        setServerError(e);
      })
      .finally(() => {
        if (id !== serverCheckRef.current) return;
        setServerChecking(false);
      });
  }, []);

  useEffect(() => {
    checkServer();
  }, [checkServer]);

  // Durum eskiden YALNIZCA açılışta kontrol ediliyordu: sunucu geri geldiğinde
  // kart "Bağlanamıyor"da kalıyor, düzelmesi için uygulamayı kapatıp açmak
  // gerekiyordu. Artık ön plana dönüşte de tazeleniyor.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') checkServer();
    });
    return () => sub.remove();
  }, [checkServer]);

  const handlePullRefresh = async () => {
    setPullRefreshing(true);
    // try/finally: refreshDevices beklenmedik şekilde reddederse daire
    // sonsuza kadar dönerdi.
    try {
      checkServer();
      await refreshDevices({ force: true });
    } finally {
      setPullRefreshing(false);
    }
  };

  const handleRemoveDevice = (device: ApiDevice) => {
    Alert.alert('Cihazı çıkar', `"${device.name}" sistemden çıkarılacak. Emin misin?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Çıkar',
        style: 'destructive',
        onPress: async () => {
          setRemovingId(device.id);
          try {
            await removeDevice(device.id);
            await refreshDevices({ force: true });
            triggerBurstCheck();
          } catch (e) {
            Alert.alert('Cihaz çıkarılamadı', describeError(e).message);
          } finally {
            setRemovingId(null);
          }
        },
      },
    ]);
  };

  const hasPayload = picked.length > 0 || note.trim().length > 0;
  const valid = hasPayload;

  const pickFiles = async () => {
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    } catch {
      setUploadErr('Dosya seçici açılamadı');
      return;
    }
    if (result.canceled) return;
    setDone(false);
    setUploadErr(null);
    setPicked(result.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType })));
  };

  /**
   * Seçimi boşaltmanın yolu yoktu: yanlış dosya seçen kullanıcı ancak başarılı
   * bir yükleme yapıp "Yeni"ye basarak "dosya yok" durumuna dönebiliyordu
   * (pickFiles iptal edilince eski seçim korunuyor).
   */
  const clearFiles = () => {
    setPicked([]);
    setDone(false);
    setUploadErr(null);
    setProgress(0);
  };

  const badgeColors = useMemo(() => t.badge, [t]);

  const send = async () => {
    if (!valid || sending) return;
    setSending(true);
    setDone(false);
    setUploadErr(null);
    setProgress(0);
    try {
      await uploadFiles(
        picked.map((f) => ({ uri: f.uri, name: f.name, mimeType: f.mimeType })),
        note,
        // Math.min: muhasebede ileride bir kayma olursa bile yüzde 100 aşılmasın.
        (sentBytes, totalBytes) => setProgress(totalBytes ? Math.min(100, (sentBytes / totalBytes) * 100) : 0)
        // Hedef klasör seçimi kaldırıldı: Aktarım her zaman depo köküne yükler.
        // Belirli bir klasöre yüklemek için Dosyalar sekmesinde o klasöre girip
        // "Buraya Yükle" kullanılıyor - targetPath'i oradaki akış hâlâ kullanıyor.
      );
      // Başarıdan sonra seçim TAMAMEN sıfırlanıyor: eskiden dosyalar listede
      // kalıyordu ve kullanıcı aynı dosyaları yanlışlıkla tekrar gönderebiliyor,
      // ya da gönderilip gönderilmediğini anlayamıyordu. Özet önce saklanıyor,
      // çünkü "Yüklendi" bildirimi kaç dosya gittiğini yazıyor - listeyi
      // temizledikten sonra o bilgi kaybolurdu.
      setSentSummary(picked.length ? `${picked.length} dosya` : 'Not');
      setPicked([]);
      setNote('');
      setSending(false);
      setDone(true);
      setProgress(100);
      // Yeni aktarım Bildirimler sekmesinde 60sn'lik poll'u beklemeden görünsün.
      triggerBurstCheck();
    } catch (e) {
      setSending(false);
      setProgress(0);
      setUploadErr(describeError(e).message);
    }
  };

  /** Toast'taki "Yeni" — seçimi ve notu boşaltıp yeni bir aktarıma hazırlar. */
  const reset = () => {
    setPicked([]);
    setNote('');
    setDone(false);
    setProgress(0);
    setUploadErr(null);
    setSentSummary(null);
  };

  const serverProblem = serverError ? describeError(serverError) : null;
  const deviceProblem = devicesError ? describeError(devicesError) : null;

  const statusTitle = sending
    ? 'Sunucuya yükleniyor'
    : uploadErr
    ? 'Yükleme başarısız'
    : done
    ? 'Yükleme tamamlandı'
    : valid
    ? 'Yüklemeye hazır'
    : 'Ne yüklemek istiyorsun?';

  const statusHint = sending
    ? `${Math.round(progress)}% tamamlandı`
    : uploadErr
    ? uploadErr
    : done
    ? 'Yeni bir aktarım başlatabilirsin.'
    : valid
    ? `${picked.length ? `${picked.length} dosya` : 'Not'} → Ev Sunucusu`
    : 'Dosya seç ya da bir not yaz — ikisi de yüklenebilir.';

  const btnBg = sending ? t.accentDeep : valid ? t.accent : t.btnIdle;
  const btnFg = valid || sending ? t.onAccent : t.btnIdleFg;
  const btnBorder = valid || sending ? 'transparent' : t.btnIdleBorder;

  const serverDotColor = serverChecking ? t.dim : serverProblem ? t.danger : t.helperOk;
  const serverLabel = serverChecking ? 'Kontrol ediliyor…' : serverProblem ? serverProblem.short : 'Bağlı';

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Aktarım</Text>
          <Text style={[styles.subtitle, { color: t.accentText }]}>Sunucuya dosya yükle</Text>
        </View>
        <Pressable
          onPress={toggleTheme}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={dark ? 'Açık temaya geç' : 'Koyu temaya geç'}
          style={[styles.themeBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Ionicons name={dark ? 'moon' : 'sunny'} size={18} color={t.accentText} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollBody, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          // react-native-web RefreshControl'ü DOM'a hiç basmıyor (ölçüldü):
          // masaüstünde aşağı çekerek yenileme diye bir şey yok, orada
          // App.tsx'teki yüzen yenile tuşu kullanılıyor.
          Platform.OS === 'web' ? undefined : (
            <RefreshControl
              refreshing={pullRefreshing}
              onRefresh={handlePullRefresh}
              tintColor={t.accent}
              colors={[t.accent]}
            />
          )
        }>
        {/* 1 — DURUM: eski dev halkanın yerine kompakt bir kart. */}
        <View
          style={[styles.statusCard, { backgroundColor: t.surface, borderColor: uploadErr ? t.helperWarn : t.border }]}>
          <View style={[styles.statusIcon, { backgroundColor: uploadErr ? t.track : t.accentSoft }]}>
            {sending ? (
              <ActivityIndicator size="small" color={t.accentText} />
            ) : (
              <Ionicons
                name={uploadErr ? 'alert-circle-outline' : done ? 'checkmark-circle-outline' : 'cloud-upload-outline'}
                size={22}
                color={uploadErr ? t.helperWarn : t.accentText}
              />
            )}
          </View>
          <View style={styles.statusBody}>
            <Text style={[styles.statusTitle, { color: uploadErr ? t.helperWarn : t.text }]}>{statusTitle}</Text>
            <Text style={[styles.statusHint, { color: uploadErr ? t.helperWarn : t.muted }]}>{statusHint}</Text>
            {sending ? (
              <View style={[styles.track, { backgroundColor: t.track }]}>
                <View style={[styles.trackFill, { backgroundColor: t.accent, width: `${Math.round(progress)}%` }]} />
              </View>
            ) : null}
          </View>
        </View>

        {/* 2 — DOSYA: asıl eylem, seçilenler artık ekranın üst yarısında. */}
        <View style={[styles.block, { backgroundColor: t.surface, borderColor: t.border }]}>
          <View style={styles.blockHeader}>
            <View style={styles.blockHeaderLeft}>
              <Ionicons name="document-outline" size={15} color={t.icon} />
              <Text style={[styles.blockLabel, { color: t.muted }]}>DOSYA</Text>
            </View>
            {picked.length > 0 ? (
              <Pressable
                onPress={clearFiles}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Dosya seçimini temizle"
                style={styles.smallAction}>
                <Text style={[styles.smallActionLabel, { color: t.muted }]}>Temizle</Text>
              </Pressable>
            ) : null}
          </View>

          {picked.length > 0 ? (
            <View style={styles.fileList}>
              {picked.slice(0, 3).map((f, i) => (
                <View key={`${f.uri}-${i}`} style={styles.fileRow}>
                  <View style={[styles.fileBadge, { backgroundColor: badgeColors[i % badgeColors.length] }]}>
                    <Text style={[styles.fileBadgeText, { color: t.onAccent }]}>{getExt(f.name)}</Text>
                  </View>
                  <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.fileName, { color: t.text }]}>
                    {f.name}
                  </Text>
                </View>
              ))}
              {picked.length > 3 ? (
                <Text style={[styles.fileMore, { color: t.muted }]}>+{picked.length - 3} dosya daha</Text>
              ) : null}
              <Pressable
                onPress={pickFiles}
                accessibilityRole="button"
                accessibilityLabel="Dosya seçimini değiştir"
                style={[styles.secondaryBtn, { borderColor: t.accent }]}>
                <Ionicons name="swap-horizontal-outline" size={15} color={t.accentText} />
                <Text style={[styles.secondaryBtnLabel, { color: t.accentText }]}>Değiştir</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={pickFiles}
              accessibilityRole="button"
              accessibilityLabel="Dosya seç"
              style={[styles.emptyPick, { borderColor: t.dashed }]}>
              <Ionicons name="add-circle-outline" size={22} color={t.icon} />
              <Text style={[styles.emptyPickText, { color: t.muted }]}>Dosya seç</Text>
              <Text style={[styles.emptyPickHint, { color: t.dim }]}>opsiyonel — sadece not da gönderebilirsin</Text>
            </Pressable>
          )}
        </View>

        {/* 3 — NOT + SUNUCU: eski üçlü kart ikiye bölündü ve aşağı alındı. */}
        <View style={styles.twoCol}>
          <View style={[styles.block, styles.colGrow, { backgroundColor: t.surface, borderColor: t.border }]}>
            <View style={styles.blockHeaderLeft}>
              <Ionicons name="create-outline" size={15} color={t.icon} />
              <Text style={[styles.blockLabel, { color: t.muted }]}>NOT</Text>
            </View>
            <TextInput
              value={note}
              onChangeText={(v) => {
                setDone(false);
                setUploadErr(null);
                setNote(v.slice(0, 280));
              }}
              placeholder="Mesaj yaz…"
              placeholderTextColor={t.dim}
              accessibilityLabel="Not"
              multiline
              style={[styles.noteInput, { borderColor: t.border, backgroundColor: t.inputBg, color: t.text }]}
            />
            <Text style={[styles.noteCount, { color: t.muted }]}>{note.length}/280</Text>
          </View>

          <Pressable
            onPress={checkServer}
            accessibilityRole="button"
            accessibilityLabel="Sunucu durumunu yeniden kontrol et"
            style={[styles.block, styles.colServer, { backgroundColor: t.surface, borderColor: t.border }]}>
            <View style={styles.blockHeaderLeft}>
              <Ionicons name="server-outline" size={15} color={t.icon} />
              <Text style={[styles.blockLabel, { color: t.muted }]}>SUNUCU</Text>
            </View>
            <View style={styles.serverBody}>
              <Text numberOfLines={1} style={[styles.rowCardValue, { color: t.text }]}>
                Ev Sunucusu
              </Text>
              <View style={styles.serverStatusRow}>
                <View style={[styles.dot, { backgroundColor: serverDotColor }]} />
                <Text numberOfLines={1} style={[styles.serverStatus, { color: t.muted }]}>
                  {serverLabel}
                </Text>
              </View>
              {/* Kartın dokunulabilir olduğu eskiden hiçbir şekilde belli
                  değildi; oysa durumu yeniden kontrol etmenin tek yolu buydu. */}
              <Text style={[styles.serverRecheck, { color: t.accentText }]}>Yeniden kontrol et</Text>
            </View>
          </Pressable>
        </View>

        {/* 4 — CİHAZLAR: durum bilgisi, en aşağı alındı. */}
        <View style={styles.deviceSection}>
          <View style={styles.deviceSectionHeader}>
            <Text style={[styles.blockLabel, { color: t.muted }]}>EŞLEŞTİRİLMİŞ CİHAZLAR</Text>
            <View style={styles.deviceSectionActions}>
              <Pressable
                onPress={() => router.push('/server-settings')}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Sunucu ayarları"
                style={[styles.iconBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
                <Ionicons name="settings-outline" size={16} color={t.accentText} />
              </Pressable>
              <Pressable
                onPress={() => router.push('/pair-device')}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Cihaz ekle"
                style={[styles.iconBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
                <Ionicons name="add" size={16} color={t.accentText} />
              </Pressable>
            </View>
          </View>

          {reconnecting ? (
            <View style={[styles.banner, { backgroundColor: t.rowBgSel, borderColor: t.helperWarn }]}>
              <ActivityIndicator size="small" color={t.helperWarn} />
              <Text style={[styles.bannerText, { color: t.helperWarn, flexShrink: 1 }]}>
                Sunucuya ulaşılamıyor, tekrar deneniyor ({reconnectAttempt}/3)…
              </Text>
              {/* Kullanıcı eskiden 29 saniye boyunca hiçbir iptal imkânı
                  olmadan bekliyordu. */}
              <Pressable
                onPress={cancelDeviceRequest}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Denemeyi durdur"
                style={styles.smallAction}>
                <Text style={[styles.smallActionLabel, { color: t.accentText }]}>Durdur</Text>
              </Pressable>
            </View>
          ) : deviceProblem ? (
            <View
              style={[
                styles.pairPrompt,
                { backgroundColor: t.surface, borderColor: deviceProblem.isFailure ? t.helperWarn : t.border },
              ]}>
              <Ionicons
                name={deviceProblem.action === 'configure-server' ? 'settings-outline' : 'link-outline'}
                size={18}
                color={deviceProblem.isFailure ? t.helperWarn : t.muted}
              />
              <Text style={[styles.pairPromptText, { color: deviceProblem.isFailure ? t.helperWarn : t.muted }]}>
                {deviceProblem.message}
              </Text>
              {deviceProblem.action === 'configure-server' ? (
                <Pressable
                  onPress={() => router.push('/server-settings')}
                  accessibilityRole="button"
                  accessibilityLabel="Sunucu adresi gir"
                  style={[styles.pairPromptBtn, { backgroundColor: t.accent }]}>
                  <Text style={[styles.pairPromptBtnLabel, { color: t.onAccent }]}>Sunucu Adresi Gir</Text>
                </Pressable>
              ) : deviceProblem.action === 'pair-device' ? (
                <Pressable
                  onPress={() => router.push('/pair-device')}
                  accessibilityRole="button"
                  accessibilityLabel="Cihaz eşleştir"
                  style={[styles.pairPromptBtn, { backgroundColor: t.accent }]}>
                  <Text style={[styles.pairPromptBtnLabel, { color: t.onAccent }]}>Cihaz Ekle</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => refreshDevices({ force: true })}
                  accessibilityRole="button"
                  accessibilityLabel="Tekrar dene"
                  style={[styles.pairPromptBtn, { backgroundColor: t.accent }]}>
                  <Text style={[styles.pairPromptBtnLabel, { color: t.onAccent }]}>Tekrar Dene</Text>
                </Pressable>
              )}
            </View>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.deviceRow}
              style={styles.deviceScroll}>
              {devicesLoading && devices.length === 0 && (
                <Text style={[styles.deviceLoading, { color: t.muted }]}>Yükleniyor…</Text>
              )}
              {!devicesLoading && devices.length === 0 && (
                <Text style={[styles.deviceLoading, { color: t.muted }]}>Bağlı cihaz yok</Text>
              )}
              {devices.map((d) => (
                <View key={d.id} style={[styles.deviceChip, { backgroundColor: t.surface, borderColor: t.border }]}>
                  <Ionicons name="desktop-outline" size={16} color={t.text} />
                  <View>
                    <Text numberOfLines={1} style={[styles.deviceChipName, { color: t.text }]}>
                      {d.name}
                    </Text>
                    <View style={styles.deviceStatusRow}>
                      <View style={[styles.dot, { backgroundColor: d.connected ? t.helperOk : t.checkOff }]} />
                      <Text style={[styles.deviceChipStatus, { color: t.muted }]}>
                        {d.connected ? 'Bağlı' : 'Bağlı değil'}
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={() => handleRemoveDevice(d)}
                    disabled={removingId === d.id}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={`${d.name} cihazını çıkar`}
                    style={styles.deviceRemoveBtn}>
                    {removingId === d.id ? (
                      <ActivityIndicator size="small" color={t.muted} />
                    ) : (
                      <Ionicons name="close-circle-outline" size={16} color={t.danger} />
                    )}
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>

        {/* 5 — YÜKLE */}
        <Pressable
          onPress={send}
          disabled={!valid || sending}
          accessibilityRole="button"
          accessibilityLabel={sending ? 'Yükleniyor' : 'Yükle'}
          accessibilityState={{ disabled: !valid || sending }}
          style={[styles.sendBtn, { backgroundColor: btnBg, borderColor: btnBorder }]}>
          <Ionicons name="arrow-up" size={18} color={btnFg} />
          <Text style={[styles.sendLabel, { color: btnFg }]}>{sending ? 'Yükleniyor…' : 'Yükle'}</Text>
        </Pressable>
      </ScrollView>

      {done && (
        <View style={[styles.toast, { backgroundColor: t.toastBg, borderColor: t.border, bottom: insets.bottom + 16 }]}>
          <View style={[styles.toastIcon, { backgroundColor: t.accent }]}>
            <Ionicons name="checkmark" size={14} color={t.onAccent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.toastTitle, { color: t.toastText }]}>Yüklendi</Text>
            <Text style={[styles.toastSub, { color: t.toastSub }]}>
              {sentSummary ?? 'Not'} → Ev Sunucusu
            </Text>
          </View>
          <Pressable
            onPress={reset}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel="Yeni aktarım başlat"
            style={styles.smallAction}>
            <Text style={[styles.toastAction, { color: t.toastAction }]}>Yeni</Text>
          </Pressable>
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, position: 'relative' },
  scrollBody: { paddingHorizontal: 20, paddingTop: 14, gap: 12 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  themeBtn: { width: 38, height: 38, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  statusCard: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, alignItems: 'flex-start' },
  statusIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  statusBody: { flex: 1, gap: 3 },
  statusTitle: { fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },
  statusHint: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
  track: { height: 6, borderRadius: 999, overflow: 'hidden', marginTop: 6 },
  trackFill: { height: '100%', borderRadius: 999 },

  block: { padding: 14, borderRadius: 16, borderWidth: 1, gap: 10 },
  blockHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  blockHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  blockLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8 },
  // Dokunma hedefi: metin ~15dp'ydi; padding + hitSlop ile 44dp'ye çıkıyor.
  smallAction: { paddingHorizontal: 6, paddingVertical: 8 },
  smallActionLabel: { fontSize: 11.5, fontWeight: '700' },

  fileList: { gap: 8 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, flexShrink: 0 },
  fileBadgeText: { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.3 },
  fileName: { flex: 1, fontSize: 12.5, fontWeight: '600' },
  fileMore: { fontSize: 11.5, fontWeight: '700' },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    borderRadius: 11,
    borderWidth: 1.5,
    marginTop: 2,
  },
  secondaryBtnLabel: { fontSize: 12.5, fontWeight: '700' },
  emptyPick: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 22,
    borderRadius: 13,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  emptyPickText: { fontSize: 13, fontWeight: '700' },
  emptyPickHint: { fontSize: 11, fontWeight: '500' },

  rowCardValue: { fontSize: 12.5, fontWeight: '700' },

  twoCol: { flexDirection: 'row', gap: 12, alignItems: 'stretch' },
  colGrow: { flex: 1.4 },
  colServer: { flex: 1 },
  noteInput: {
    minHeight: 74,
    borderWidth: 1,
    borderRadius: 11,
    padding: 10,
    fontSize: 12.5,
    fontWeight: '500',
    textAlignVertical: 'top',
  },
  noteCount: { fontSize: 10, fontWeight: '600', textAlign: 'right' },
  serverBody: { gap: 4, flex: 1, justifyContent: 'center' },
  serverStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  serverStatus: { fontSize: 11, fontWeight: '600', flexShrink: 1 },
  serverRecheck: { fontSize: 10.5, fontWeight: '700', marginTop: 2 },
  dot: { width: 6, height: 6, borderRadius: 999, flexShrink: 0 },

  deviceSection: { gap: 8 },
  deviceSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  deviceSectionActions: { flexDirection: 'row', gap: 8 },
  iconBtn: { width: 32, height: 32, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  bannerText: { fontSize: 12, fontWeight: '700' },
  pairPrompt: { alignItems: 'center', gap: 8, padding: 16, borderRadius: 16, borderWidth: 1 },
  pairPromptText: { fontSize: 12.5, fontWeight: '700', textAlign: 'center' },
  pairPromptBtn: { paddingHorizontal: 16, minHeight: 44, justifyContent: 'center', borderRadius: 12, marginTop: 2 },
  pairPromptBtnLabel: { fontSize: 13, fontWeight: '800' },
  deviceScroll: { flexGrow: 0 },
  deviceRow: { gap: 8, paddingBottom: 2, alignItems: 'center' },
  deviceLoading: { fontSize: 12, fontWeight: '600' },
  deviceChip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 13,
    borderWidth: 1.5,
  },
  deviceChipName: { fontSize: 12, fontWeight: '700', maxWidth: 150 },
  deviceStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  deviceChipStatus: { fontSize: 10, fontWeight: '600' },
  deviceRemoveBtn: { padding: 2 },

  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 54,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 2,
  },
  sendLabel: { fontSize: 15.5, fontWeight: '800', letterSpacing: -0.2 },

  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  toastIcon: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  toastTitle: { fontSize: 13, fontWeight: '800' },
  toastSub: { fontSize: 11, fontWeight: '600' },
  toastAction: { fontSize: 12.5, fontWeight: '800' },
});
