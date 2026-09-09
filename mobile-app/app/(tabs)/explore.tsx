import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDevices } from '@/contexts/device-context';
import { useAppTheme } from '@/contexts/theme-context';
import { ApiFileEntry, RequestCancelledError, downloadFile, getFiles, uploadFiles } from '@/services/api';
import { describeError } from '@/services/error-messages';
import { chooseDownloadFolder, getCachedDownloadFolderName } from '@/services/sharedStorage';

/** Klasörler önce, sonra her grup kendi içinde ada göre. */
function sortEntries(entries: ApiFileEntry[]): ApiFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'tr');
  });
}

function filterEntries(entries: ApiFileEntry[], q: string): ApiFileEntry[] {
  if (!q) return entries;
  const s = q.toLocaleLowerCase('tr');
  return entries.filter((e) => e.name.toLocaleLowerCase('tr').includes(s));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function DosyalarScreen() {
  const insets = useSafeAreaInsets();
  const { dark, toggleTheme, theme: t } = useAppTheme();
  const { devices, loading: devicesLoading, error: devicesError, refresh: refreshDevices } = useDevices();

  const [pathStack, setPathStack] = useState<string[]>(['/']);
  const currentPath = pathStack[pathStack.length - 1];
  const canGoBack = pathStack.length > 1;

  const [entries, setEntries] = useState<ApiFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<Error | null>(null);
  const [downloadFolderName, setDownloadFolderName] = useState<string | null>(null);

  const [selected, setSelected] = useState<Record<string, { name: string; size: number }>>({});
  const [query, setQuery] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /**
   * Klasör gezinmede YARIŞ KORUMASI. Eskiden her getFiles sonucu koşulsuz
   * state'e yazılıyordu: yavaş bağlantıda bir klasöre girip hemen geri
   * çıkınca, önce başlayıp sonra biten istek kazanıyor ve yol çubuğu "Kök
   * dizin" derken listede alt klasörün dosyaları duruyordu — kullanıcı yanlış
   * dosyayı seçip indirebiliyordu. Artık yalnızca EN SON isteğin sonucu
   * yazılıyor, önceki istek de iptal ediliyor.
   */
  const latestFilesRequestRef = useRef(0);
  const filesAbortRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback((): Promise<void> => {
    const requestId = ++latestFilesRequestRef.current;
    filesAbortRef.current?.abort();
    const controller = new AbortController();
    filesAbortRef.current = controller;

    setFilesLoading(true);
    setFilesError(null);
    return getFiles(currentPath, undefined, controller.signal)
      .then((list) => {
        if (requestId !== latestFilesRequestRef.current) return;
        setEntries(sortEntries(list));
      })
      .catch((e: Error) => {
        if (requestId !== latestFilesRequestRef.current) return;
        if (e instanceof RequestCancelledError) return;
        setEntries([]);
        setFilesError(e);
      })
      .finally(() => {
        if (requestId !== latestFilesRequestRef.current) return;
        setFilesLoading(false);
      });
  }, [currentPath]);

  useEffect(() => () => filesAbortRef.current?.abort(), []);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  useEffect(() => {
    getCachedDownloadFolderName().then(setDownloadFolderName);
  }, []);

  const handleChooseDownloadFolder = async () => {
    const name = await chooseDownloadFolder();
    if (name) setDownloadFolderName(name);
  };

  // Yenile tuşuna basıldığında ikon, veriler gelene kadar döner.
  const [refreshSpinning, setRefreshSpinning] = useState(false);
  const refreshSpin = useRef(new Animated.Value(0)).current;
  /** Veri hâlâ geliyor mu? Animasyon her tur sonunda buna bakıp devam/dur kararı verir. */
  const refreshLoadingRef = useRef(false);

  /**
   * Dönüş TUR TUR sürüyor: her tur bittiğinde veri hâlâ geliyorsa yeni bir
   * tur başlıyor, gelmişse ikon tam 0°'de duruyor.
   *
   * Neden Animated.loop değil: döngüyü ortasında durdurmak ikonu yamuk
   * bırakıyordu. Neden "işi bekleyip hemen durdur" da değil: yerel sunucuda
   * yenileme ~120 ms sürüyor ve React o kadar kısa sürede spinning=true
   * durumunu hiç render etmiyor, animasyon başlamadan bitiyordu.
   */
  useEffect(() => {
    if (!refreshSpinning) return;
    let cancelled = false;

    const runTurn = () => {
      if (cancelled) return;
      refreshSpin.setValue(0);
      // useNativeDriver false: aynı bileşen react-native-web'de de çalışıyor
      // (masaüstü uygulaması bu ekranı yeniden kullanıyor) ve orada native
      // sürücü yok - true verilirse dönüş sessizce hiç uygulanmıyor.
      Animated.timing(refreshSpin, {
        toValue: 1,
        duration: 600,
        easing: Easing.linear,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (cancelled || !finished) return;
        if (refreshLoadingRef.current) runTurn();
        else {
          refreshSpin.setValue(0);
          setRefreshSpinning(false);
        }
      });
    };

    runTurn();
    return () => {
      cancelled = true;
      // stopAnimation ŞART: yalnızca setValue(0) demek animasyonu durdurmuyordu,
      // süren Animated.timing bir sonraki karede değeri tekrar ezip turunu
      // tamamlıyordu — ölü bir bileşen için 600 ms'ye kadar boşa JS işi
      // (useNativeDriver:false olduğu için JS iş parçacığında).
      refreshSpin.stopAnimation(() => refreshSpin.setValue(0));
    };
  }, [refreshSpinning, refreshSpin]);

  const handleRefreshPress = async () => {
    if (refreshLoadingRef.current) return;
    refreshLoadingRef.current = true;
    setRefreshSpinning(true);
    try {
      // Dosya listesi VE cihaz listesi; ikisi de gelene kadar dönüş sürer.
      await Promise.all([refreshFiles(), refreshDevices({ force: true })]);
    } finally {
      // Dönüşü burada durdurmuyoruz - animasyon içinde bulunduğu turu
      // tamamlayıp kendi duruyor.
      refreshLoadingRef.current = false;
    }
  };

  const refreshRotate = refreshSpin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const [pullRefreshing, setPullRefreshing] = useState(false);
  const handlePullRefresh = async () => {
    setPullRefreshing(true);
    // try/finally şart: içerideki promise'lardan biri beklenmedik şekilde
    // reddederse setPullRefreshing(false) hiç çalışmaz ve yenileme dairesi
    // sonsuza kadar dönerdi.
    try {
      await Promise.all([refreshFiles(), refreshDevices({ force: true })]);
    } finally {
      setPullRefreshing(false);
    }
  };

  /**
   * Klasör değişince seçim de temizleniyor. Eskiden korunuyordu: A klasöründe
   * 3 dosya seçip B'ye geçince alt bar "3 dosya seçildi" diyor ama listede
   * işaretli hiçbir satır görünmüyordu; İndir'e basınca görünmeyen dosyalar
   * iniyordu. Klasörler arası seçim arayüzde hiçbir yerde gösterilmediğinden
   * korumak yerine temizlemek daha dürüst.
   */
  const leaveFolder = () => {
    setQuery('');
    setUploadDone(false);
    setUploadError(null);
    setSelected({});
    setDone(false);
    setDownloadError(null);
  };

  const openFolder = (path: string) => {
    leaveFolder();
    setPathStack((s) => [...s, path]);
  };

  const goBack = () => {
    if (!canGoBack) return;
    leaveFolder();
    setPathStack((s) => s.slice(0, -1));
  };

  /** Şu an içinde bulunulan klasöre (currentPath) dosya yükler - Aktarım
   * sekmesindeki genel yükleme akışından ayrı, gezinirken hızlı yükleme için. */
  const uploadHere = async () => {
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    } catch {
      // Seçici bazı cihazlarda açılamayabiliyor; sessizce yutmak yerine söyle.
      setUploadError('Dosya seçici açılamadı');
      return;
    }
    if (result.canceled) return;

    setUploading(true);
    setUploadDone(false);
    setUploadError(null);
    setUploadProgress(0);
    try {
      await uploadFiles(
        result.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType })),
        '',
        (sentBytes, totalBytes) =>
          setUploadProgress(totalBytes ? Math.min(100, (sentBytes / totalBytes) * 100) : 0),
        currentPath
      );
      setUploading(false);
      setUploadDone(true);
      setUploadProgress(100);
      refreshFiles();
    } catch (e) {
      setUploading(false);
      setUploadProgress(0);
      setUploadError(describeError(e).message);
    }
  };

  const toggleSelect = (entry: ApiFileEntry) => {
    if (entry.kind !== 'file') return;
    setDone(false);
    setDownloadError(null);
    setSelected((prev) => {
      const next = { ...prev };
      if (next[entry.path]) delete next[entry.path];
      else next[entry.path] = { name: entry.name, size: entry.size ?? 0 };
      return next;
    });
  };

  const query_ = query.trim();
  const rows = useMemo(() => filterEntries(entries, query_), [entries, query_]);

  const selectedPaths = Object.keys(selected);
  const count = selectedPaths.length;

  const startDownload = async () => {
    if (!count || downloading) return;

    // Sunucu bazı dosyalar için size:null döndürebiliyor (ve 0 baytlık dosyalar
    // da var). Eskiden bunlar 0 sayılıp toplam 0 oluyordu; `totalBytes || 1`
    // yüzünden ilk baytta ilerleme %100'e fırlıyor ve orada kalıyordu -
    // kullanıcı bittiğini sanıp uygulamayı kapatabiliyordu. Boyutu bilinen
    // dosya yoksa bayta göre değil, DOSYA SAYISINA göre ilerleme gösteriyoruz.
    const knownBytes = selectedPaths.reduce((sum, p) => sum + (selected[p]?.size ?? 0), 0);
    const useByteProgress = knownBytes > 0;
    let completedBytes = 0;
    let finishedFiles = 0;

    setDownloading(true);
    setDone(false);
    setDownloadError(null);
    setProgress(0);

    const failed: { name: string; message: string }[] = [];
    let succeeded = 0;

    // Dış try/finally: aşağıdaki döngüde beklenmedik bir hata oluşursa
    // downloading true kalır ve "if (!count || downloading) return" yüzünden
    // indirme tuşu bir daha ASLA çalışmazdı.
    try {
      for (const path of selectedPaths) {
        const file = selected[path];
        try {
          await downloadFile(path, file.name, (written) => {
            if (useByteProgress) {
              setProgress(Math.min(100, ((completedBytes + written) / knownBytes) * 100));
            } else {
              setProgress(Math.min(100, (finishedFiles / selectedPaths.length) * 100));
            }
          });
          completedBytes += file.size;
          finishedFiles += 1;
          succeeded += 1;
          if (!useByteProgress) setProgress((finishedFiles / selectedPaths.length) * 100);
        } catch (e) {
          // İlk hatada DÖNGÜYÜ TERK ETMİYORUZ. Eskiden `return` vardı: 10
          // dosyanın 3.'sü başarısız olunca kalan 7'si sessizce atlanıyor,
          // kullanıcı hangisinin indiğini bilemiyordu.
          finishedFiles += 1;
          failed.push({ name: file.name, message: describeError(e).message });
          if (!useByteProgress) setProgress((finishedFiles / selectedPaths.length) * 100);
        }
      }

      if (failed.length === 0) {
        setDone(true);
        setProgress(100);
        setSelected({});
      } else if (succeeded === 0) {
        setDownloadError(failed.length === 1 ? failed[0].message : `${failed.length} dosya indirilemedi`);
      } else {
        setDownloadError(`${succeeded} dosya indi, ${failed.length} dosya indirilemedi: ${failed[0].name}`);
      }
    } finally {
      setDownloading(false);
    }
  };

  const clearSelection = () => {
    setSelected({});
    setDone(false);
    setDownloadError(null);
  };

  // Tek hata-metni kaynağı (services/error-messages.ts). Eskiden her ekranda
  // ayrı bir instanceof zinciri vardı ve son else dalı HER hatayı "Sunucuya
  // ulaşılamıyor" yapıyordu - sunucu 500 dönerken bile.
  const deviceProblem = devicesError ? describeError(devicesError) : null;
  const fileProblem = filesError ? describeError(filesError) : null;

  const hint = downloadError
    ? downloadError
    : done
    ? 'İndirme tamamlandı'
    : count
    ? 'İndirilecek dosya seçildi'
    : 'İndirmek için dosya seç';

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Dosyalar</Text>
          <Text style={[styles.subtitle, { color: t.accentText }]}>Sunucudaki güncel belgeler</Text>
        </View>
        <View style={styles.headerBtns}>
          <Pressable
            onPress={handleRefreshPress}
            hitSlop={6}
            accessibilityRole="button"
            // Etiket duruma göre değişiyor: react-native-web
            // accessibilityState.busy'yi aria-busy'ye ÇEVİRMİYOR (ölçüldü:
            // dönerken bile aria-busy null), etiket ise her iki platformda
            // da ekran okuyucuya ulaşıyor.
            accessibilityLabel={refreshSpinning ? 'Yenileniyor' : 'Listeyi yenile'}
            accessibilityState={{ busy: refreshSpinning, disabled: refreshSpinning }}
            style={[styles.themeBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Animated.View style={{ transform: [{ rotate: refreshRotate }] }}>
              <Ionicons name="refresh" size={18} color={t.accentText} />
            </Animated.View>
          </Pressable>
          <Pressable
            onPress={toggleTheme}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={dark ? 'Açık temaya geç' : 'Koyu temaya geç'}
            style={[styles.themeBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Ionicons name={dark ? 'moon' : 'sunny'} size={18} color={t.accentText} />
          </Pressable>
        </View>
      </View>

      <View style={styles.downloadFolderWrap}>
        <View style={[styles.downloadFolderCard, { backgroundColor: t.surface, borderColor: t.border }]}>
          <View style={[styles.deviceIcon, { backgroundColor: t.accentSoft }]}>
            <Ionicons name="folder-outline" size={16} color={t.accentText} />
          </View>
          <View style={styles.downloadFolderInfo}>
            <Text style={[styles.cardColLabel, { color: t.muted }]}>İNDİRME KLASÖRÜ</Text>
            <Text numberOfLines={1} style={[styles.deviceName, { color: t.text }]}>
              {downloadFolderName ?? 'Henüz seçilmedi'}
            </Text>
            {/* Resim ve videolar SAF klasörüne değil medya kütüphanesine
                kaydediliyor (saveToSharedStorage). Kartta yalnızca "İNDİRME
                KLASÖRÜ" yazarken dosyanın oraya gitmemesi kullanıcıya
                "indirme başarısız" gibi görünüyordu. */}
            <Text style={[styles.downloadFolderNote, { color: t.muted }]}>Resim ve videolar galeriye kaydedilir</Text>
          </View>
          <Pressable
            onPress={handleChooseDownloadFolder}
            accessibilityRole="button"
            accessibilityLabel={downloadFolderName ? 'İndirme klasörünü değiştir' : 'İndirme klasörü seç'}
            style={[styles.downloadFolderBtn, { borderColor: t.accent }]}>
            <Text style={[styles.downloadFolderBtnLabel, { color: t.accentText }]}>
              {downloadFolderName ? 'Değiştir' : 'Klasör Seç'}
            </Text>
          </Pressable>
        </View>
      </View>

      <Text style={[styles.sectionLabel, { color: t.muted }]}>AĞDAKİ CİHAZLAR</Text>
      {deviceProblem ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: t.rowBgSel,
              borderColor: deviceProblem.isFailure ? t.helperWarn : t.border,
              marginHorizontal: 20,
            },
          ]}>
          <Ionicons
            name={deviceProblem.isFailure ? 'alert-circle-outline' : 'information-circle-outline'}
            size={16}
            color={deviceProblem.isFailure ? t.helperWarn : t.muted}
          />
          <View style={styles.bannerBody}>
            <Text style={[styles.bannerText, { color: deviceProblem.isFailure ? t.helperWarn : t.muted }]}>
              {deviceProblem.message}
            </Text>
            {deviceProblem.hint ? (
              <Text style={[styles.bannerHint, { color: t.muted }]}>{deviceProblem.hint}</Text>
            ) : null}
          </View>
          {deviceProblem.action === 'configure-server' ? (
            <Pressable
              onPress={() => router.push('/server-settings')}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Sunucu adresi gir"
              style={styles.bannerActionBtn}>
              <Text style={[styles.bannerActionLabel, { color: t.accentText }]}>Ayarla</Text>
            </Pressable>
          ) : deviceProblem.action === 'pair-device' ? (
            <Pressable
              onPress={() => router.push('/pair-device')}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Cihaz eşleştir"
              style={styles.bannerActionBtn}>
              <Text style={[styles.bannerActionLabel, { color: t.accentText }]}>Eşleştir</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.deviceRow}
          style={styles.deviceScroll}>
          {devicesLoading && <Text style={[styles.deviceLoading, { color: t.muted }]}>Yükleniyor…</Text>}
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
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.breadcrumbRow}>
        {canGoBack ? (
          <Pressable
            onPress={goBack}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Üst klasöre dön"
            style={styles.breadcrumbBack}>
            <Ionicons name="chevron-back" size={18} color={t.accentText} />
            <Text style={[styles.breadcrumbBackLabel, { color: t.accentText }]}>Geri</Text>
          </Pressable>
        ) : null}
        <Text numberOfLines={1} style={[styles.breadcrumbPath, { color: t.muted }]}>
          {currentPath === '/' ? 'Kök dizin' : currentPath}
        </Text>
        <Pressable
          onPress={uploadHere}
          disabled={uploading}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Buraya yükle"
          style={[styles.uploadHereBtn, { borderColor: t.accent, opacity: uploading ? 0.6 : 1 }]}>
          <Ionicons name="cloud-upload-outline" size={15} color={t.accentText} />
          <Text style={[styles.uploadHereLabel, { color: t.accentText }]}>Buraya Yükle</Text>
        </Pressable>
      </View>

      {(uploading || uploadDone || uploadError) && (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: t.rowBgSel,
              borderColor: uploadError ? t.helperWarn : t.border,
              marginHorizontal: 20,
              marginTop: 10,
            },
          ]}>
          {uploading ? (
            <ActivityIndicator size="small" color={t.accentText} />
          ) : uploadError ? (
            <Ionicons name="alert-circle-outline" size={16} color={t.helperWarn} />
          ) : (
            <Ionicons name="checkmark-circle-outline" size={16} color={t.accentText} />
          )}
          <Text style={[styles.bannerText, { color: uploadError ? t.helperWarn : t.muted, flexShrink: 1 }]}>
            {uploading
              ? `Yükleniyor… ${Math.round(uploadProgress)}%`
              : uploadError
              ? uploadError
              : 'Buraya yüklendi'}
          </Text>
        </View>
      )}

      <View style={styles.searchWrap}>
        <View style={[styles.searchBar, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Ionicons name="search-outline" size={16} color={t.accentText} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Dosya ara"
            placeholderTextColor={t.dim}
            accessibilityLabel="Dosya ara"
            style={[styles.searchInput, { color: t.text }]}
          />
        </View>
      </View>

      {fileProblem ? (
        <View style={styles.centerFill}>
          <Ionicons
            name={
              fileProblem.action === 'configure-server'
                ? 'settings-outline'
                : fileProblem.action === 'pair-device'
                ? 'link-outline'
                : 'cloud-offline-outline'
            }
            size={28}
            color={fileProblem.isFailure ? t.helperWarn : t.muted}
          />
          <Text style={[styles.emptyText, { color: fileProblem.isFailure ? t.helperWarn : t.muted }]}>
            {fileProblem.message}
          </Text>
          {fileProblem.hint ? <Text style={[styles.emptyHint, { color: t.muted }]}>{fileProblem.hint}</Text> : null}
          {fileProblem.action === 'configure-server' ? (
            <Pressable
              onPress={() => router.push('/server-settings')}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Sunucu adresi gir"
              style={[styles.retryBtn, { borderColor: t.accent }]}>
              <Text style={[styles.retryLabel, { color: t.accentText }]}>Sunucu Adresi Gir</Text>
            </Pressable>
          ) : fileProblem.action === 'pair-device' ? (
            <Pressable
              onPress={() => router.push('/pair-device')}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Cihaz eşleştir"
              style={[styles.retryBtn, { borderColor: t.accent }]}>
              <Text style={[styles.retryLabel, { color: t.accentText }]}>Cihaz Eşleştir</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={refreshFiles}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Tekrar dene"
              style={[styles.retryBtn, { borderColor: t.accent }]}>
              <Text style={[styles.retryLabel, { color: t.accentText }]}>Tekrar dene</Text>
            </Pressable>
          )}
        </View>
      ) : filesLoading && entries.length === 0 ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={t.accentText} />
          <Text style={[styles.emptyText, { color: t.muted }]}>Yükleniyor…</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
          // react-native-web RefreshControl'ü DOM'a hiç basmıyor (ölçüldü):
          // masaüstünde aşağı çekerek yenileme diye bir şey yok, orada
          // App.tsx'teki yüzen yenile tuşu kullanılıyor. Web'de null vermek
          // ölü bir bileşenin monte edilmesini engelliyor.
          Platform.OS === 'web' ? undefined : (
            <RefreshControl refreshing={pullRefreshing} onRefresh={handlePullRefresh} tintColor={t.accent} colors={[t.accent]} />
          )
        }>
          {rows.map((entry) => {
            const isFolder = entry.kind === 'folder';
            const checked = !!selected[entry.path];
            const meta = isFolder
              ? new Date(entry.modifiedAt).toLocaleDateString('tr-TR')
              : `${formatBytes(entry.size ?? 0)} · ${new Date(entry.modifiedAt).toLocaleDateString('tr-TR')}`;

            return (
              <View
                key={entry.path}
                style={[
                  styles.row,
                  {
                    backgroundColor: checked ? t.rowBgSel : t.rowBg,
                    borderColor: checked ? t.accent : t.rowBorder,
                  },
                ]}>
                <Pressable
                  onPress={() => (isFolder ? openFolder(entry.path) : toggleSelect(entry))}
                  accessibilityRole="button"
                  accessibilityLabel={isFolder ? `${entry.name} klasörü` : `${entry.name}, ${meta}`}
                  style={styles.rowMain}>
                  {isFolder ? (
                    <>
                      <Ionicons name="chevron-forward" size={16} color={t.accentText} />
                      <View style={[styles.folderIcon, { backgroundColor: t.accentSoft }]}>
                        <Ionicons name="folder" size={16} color={t.accentText} />
                      </View>
                    </>
                  ) : (
                    <>
                      <View style={{ width: 16 }} />
                      <Ionicons name="document-outline" size={18} color={t.muted} />
                    </>
                  )}
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={[styles.rowName, { color: t.text }]}>
                      {entry.name}
                    </Text>
                    <Text style={[styles.rowMeta, { color: t.muted }]}>{meta}</Text>
                  </View>
                </Pressable>
                {!isFolder && (
                  <Pressable
                    onPress={() => toggleSelect(entry)}
                    hitSlop={11}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    accessibilityLabel={`${entry.name} seç`}
                    style={[
                      styles.checkbox,
                      {
                        backgroundColor: checked ? t.accent : 'transparent',
                        borderColor: checked ? t.accent : t.checkOff,
                      },
                    ]}>
                    {checked && <Ionicons name="checkmark" size={12} color={t.onAccent} />}
                  </Pressable>
                )}
              </View>
            );
          })}
          {rows.length === 0 && (
            <View style={styles.emptyState}>
              <Ionicons name={entries.length === 0 ? 'folder-open-outline' : 'search-outline'} size={22} color={t.dim} />
              <Text style={[styles.emptyText, { color: t.muted }]}>
                {entries.length === 0 ? (currentPath === '/' ? 'Henüz dosya yok' : 'Bu klasör boş') : 'Sonuç bulunamadı'}
              </Text>
              <Text style={[styles.emptyHint, { color: t.dim }]}>
                {entries.length === 0
                  ? currentPath === '/'
                    ? 'Aktarım sekmesinden dosya yükleyebilirsin'
                    : ''
                  : 'Farklı bir arama terimi dene'}
              </Text>
            </View>
          )}
        </ScrollView>
      )}

      <View style={[styles.footer, { backgroundColor: t.surface, borderColor: t.border, paddingBottom: insets.bottom + 14 }]}>
        {downloading && (
          <View style={styles.progressWrap}>
            <View style={styles.progressLabelRow}>
              <Text style={[styles.progressLabel, { color: t.accentText }]}>İndiriliyor</Text>
              <Text style={[styles.progressLabel, { color: t.accentText }]}>{Math.round(progress)}%</Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: t.track }]}>
              <View style={[styles.progressFill, { backgroundColor: t.accent, width: `${Math.round(progress)}%` }]} />
            </View>
          </View>
        )}
        <View style={styles.selectionRow}>
          <Text style={[styles.selectionLabel, { color: count ? t.accentText : t.muted }]}>
            {count ? `${count} dosya seçildi` : 'Hiç dosya seçilmedi'}
          </Text>
          <Pressable
            onPress={clearSelection}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Seçimi temizle"
            style={styles.clearBtn}>
            <Text style={[styles.clearLabel, { color: t.muted }]}>Temizle</Text>
          </Pressable>
        </View>
        <Pressable
          onPress={startDownload}
          disabled={!count || downloading}
          accessibilityRole="button"
          accessibilityLabel="Seçili dosyaları indir"
          accessibilityState={{ disabled: !count || downloading }}
          style={[
            styles.downloadBtn,
            { backgroundColor: t.surface, borderColor: count ? t.accent : t.border, opacity: count ? 1 : 0.55 },
          ]}>
          <Ionicons name="arrow-down" size={19} color={count ? t.text : t.muted} />
          <Text style={[styles.downloadLabel, { color: count ? t.text : t.muted }]}>İndir</Text>
        </Pressable>
        <Text style={[styles.hint, { color: downloadError ? t.helperWarn : done ? t.accentText : t.muted }]}>{hint}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, position: 'relative' },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  headerBtns: { flexDirection: 'row', gap: 8 },
  themeBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8 },
  downloadFolderWrap: { paddingHorizontal: 20, paddingTop: 12 },
  downloadFolderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  downloadFolderInfo: { flex: 1, minWidth: 0 },
  downloadFolderBtn: { paddingHorizontal: 14, paddingVertical: 13, borderRadius: 11, borderWidth: 1.5, minHeight: 44, justifyContent: 'center' },
  downloadFolderBtnLabel: { fontSize: 12, fontWeight: '700' },
  cardColLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5 },
  downloadFolderNote: { fontSize: 10.5, fontWeight: '500', marginTop: 2 },
  deviceIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  deviceName: { fontSize: 11, fontWeight: '700', lineHeight: 14 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  bannerBody: { flex: 1, gap: 2 },
  bannerText: { fontSize: 12, fontWeight: '700' },
  bannerHint: { fontSize: 11, fontWeight: '500' },
  // Dokunma hedefi: metnin kendisi ~14dp'ydi, hitSlop 6 ile 26dp ediyordu.
  bannerActionBtn: { paddingHorizontal: 6, paddingVertical: 8 },
  bannerActionLabel: { fontSize: 11.5, fontWeight: '800' },
  deviceScroll: { flexGrow: 0 },
  deviceRow: { paddingHorizontal: 20, gap: 8, paddingBottom: 2, alignItems: 'center' },
  deviceLoading: { fontSize: 12, fontWeight: '600' },
  deviceChip: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 13, borderWidth: 1.5 },
  deviceChipName: { fontSize: 12, fontWeight: '700', maxWidth: 150 },
  deviceStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  dot: { width: 5, height: 5, borderRadius: 999 },
  deviceChipStatus: { fontSize: 9.5, fontWeight: '600' },
  breadcrumbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  breadcrumbBack: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0, paddingVertical: 12, paddingRight: 6 },
  breadcrumbBackLabel: { fontSize: 12.5, fontWeight: '700' },
  breadcrumbPath: { fontSize: 11.5, fontWeight: '600', flex: 1 },
  uploadHereBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    flexShrink: 0,
    minHeight: 44,
  },
  uploadHereLabel: { fontSize: 11, fontWeight: '700' },
  searchWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, minHeight: 46 },
  searchInput: { flex: 1, fontSize: 13.5, fontWeight: '600', padding: 0, minHeight: 44 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingBottom: 10, gap: 6 },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 30 },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 11, borderWidth: 1.5 },
  retryLabel: { fontSize: 12.5, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 10, borderRadius: 13, borderWidth: 1 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, minWidth: 0 },
  folderIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  rowName: { fontSize: 13.5, fontWeight: '700' },
  rowMeta: { fontSize: 10.5, fontWeight: '600' },
  checkbox: { width: 22, height: 22, borderRadius: 8, borderWidth: 1.6, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  emptyState: { alignItems: 'center', gap: 6, paddingVertical: 30 },
  emptyText: { textAlign: 'center', fontSize: 13, fontWeight: '600' },
  emptyHint: { textAlign: 'center', fontSize: 11.5, fontWeight: '500' },
  footer: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1 },
  progressWrap: { gap: 8, paddingBottom: 12 },
  progressLabelRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: { fontSize: 11.5, fontWeight: '700' },
  progressTrack: { height: 6, borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999 },
  selectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 11 },
  selectionLabel: { fontSize: 12, fontWeight: '700' },
  clearBtn: { paddingHorizontal: 8, paddingVertical: 14, justifyContent: 'center' },
  clearLabel: { fontSize: 11.5, fontWeight: '700' },
  downloadBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 15, borderRadius: 16, borderWidth: 1 },
  downloadLabel: { fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },
  hint: { textAlign: 'center', fontSize: 11, fontWeight: '700', paddingTop: 9 },
});
