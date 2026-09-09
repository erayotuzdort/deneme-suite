import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Swipeable, { SwipeDirection } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDevices } from '@/contexts/device-context';
import { useNotifications, type Note } from '@/contexts/notifications-context';
import { useAppTheme } from '@/contexts/theme-context';
import { findSavedFile, forgetSavedFiles } from '@/services/downloadRegistry';
import { describeError, type ErrorPresentation } from '@/services/error-messages';
import { openSavedFile } from '@/services/sharedStorage';

type Filter = 'Tümü' | 'Gelen' | 'Giden' | 'Başarısız';
const FILTERS: Filter[] = ['Tümü', 'Gelen', 'Giden', 'Başarısız'];

export default function BildirimlerScreen() {
  const insets = useSafeAreaInsets();
  const { dark, toggleTheme, theme: t } = useAppTheme();
  const { devices, loading: devicesLoading, error: devicesError, reconnecting, refresh: refreshDevices } = useDevices();
  const {
    notes,
    incomingCount,
    dismiss,
    dismissMany,
    refresh: refreshNotes,
    unsupported,
    error: notesError,
  } = useNotifications();
  const [filter, setFilter] = useState<Filter>('Tümü');
  const [pullRefreshing, setPullRefreshing] = useState(false);

  /**
   * SİLME MODU
   * Üstteki tuş modu açar (ve modda "İptal et"e dönüşür), kartlar seçilebilir
   * hâle gelir, altta seçim sayısıyla birlikte bir Sil çubuğu belirir.
   * Donanım geri tuşu da modu kapatır.
   */
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // Donanım geri tuşu: silme modundayken ekrandan çıkmak yerine modu kapatsın.
  // true döndürmek olayı tüketir, yani sekme/geçmiş navigasyonu tetiklenmez.
  useEffect(() => {
    if (!selectionMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitSelection();
      return true;
    });
    return () => sub.remove();
  }, [selectionMode, exitSelection]);

  // Liste değişince (yenileme, silme) artık var olmayan seçimleri düşür;
  // aksi hâlde "3 seçildi" derken listede 1 kart kalabiliyordu.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(notes.map((n) => n.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [notes]);

  const handlePullRefresh = async () => {
    setPullRefreshing(true);
    // try/finally: içerideki promise'lardan biri beklenmedik şekilde
    // reddederse daire sonsuza kadar dönerdi.
    try {
      await Promise.all([refreshDevices({ force: true }), refreshNotes()]);
    } finally {
      setPullRefreshing(false);
    }
  };

  const visible = useMemo(
    () =>
      notes.filter((n) => {
        if (filter === 'Gelen') return n.kind === 'incoming';
        if (filter === 'Giden') return n.kind === 'outgoing';
        if (filter === 'Başarısız') return n.kind === 'failed';
        return true;
      }),
    [notes, filter]
  );

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Seçilenleri sil: kayıtları listeden düşür, indirme defterindeki izlerini de temizle. */
  const deleteSelected = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const fileNames = notes.filter((n) => selectedIds.has(n.id)).map((n) => n.fileName);
    dismissMany(ids);
    forgetSavedFiles(fileNames);
    exitSelection();
  }, [selectedIds, notes, dismissMany, exitSelection]);

  /**
   * Karta dokununca dosyayı aç. Dosya telefonda bulunamıyorsa (hiç indirilmemiş,
   * ya da sonradan silinmiş) kullanıcıya bunu söyle.
   */
  const openNote = useCallback(async (note: Note) => {
    const saved = await findSavedFile(note.fileName);
    if (!saved) {
      Alert.alert('Dosya bulunamadı', `"${note.fileName}" bu telefona indirilmemiş.`);
      return;
    }
    if (saved.kind === 'gallery') {
      Alert.alert('Galeride', `"${note.fileName}" galeriye kaydedildi, oradan açabilirsin.`);
      return;
    }
    const result = await openSavedFile(saved.uri, saved.mimeType);
    if (result === 'missing') {
      Alert.alert('Dosya bulunamadı', `"${note.fileName}" kaydedildiği yerde yok — silinmiş ya da taşınmış olabilir.`);
    } else if (result === 'no-app') {
      Alert.alert('Açılamıyor', 'Bu dosya türünü açabilen bir uygulama yüklü değil.');
    } else if (result === 'failed') {
      Alert.alert('Dosya bulunamadı', `"${note.fileName}" açılamadı.`);
    }
  }, []);

  const deviceProblem: ErrorPresentation | null = devicesError ? describeError(devicesError) : null;

  const renderItem = useCallback(
    ({ item: n }: { item: Note }) => {
      const isIncoming = n.kind === 'incoming';
      const isOutgoing = n.kind === 'outgoing';
      const isFailed = n.kind === 'failed';
      const checked = selectedIds.has(n.id);

      const card = (
        <Animated.View
          layout={LinearTransition}
          exiting={FadeOut}
          style={[
            styles.noteCard,
            {
              backgroundColor: checked ? t.rowBgSel : t.surface,
              borderColor: checked ? t.accent : t.border,
            },
          ]}>
          {selectionMode ? (
            <View
              style={[
                styles.checkbox,
                { backgroundColor: checked ? t.accent : 'transparent', borderColor: checked ? t.accent : t.checkOff },
              ]}>
              {checked ? <Ionicons name="checkmark" size={13} color={t.onAccent} /> : null}
            </View>
          ) : (
            <View style={[styles.noteIcon, { backgroundColor: isFailed ? t.track : t.accentSoft }]}>
              {isIncoming && <Ionicons name="arrow-down" size={18} color={t.accentText} />}
              {isOutgoing && <Ionicons name="arrow-up" size={18} color={t.accentText} />}
              {isFailed && <Ionicons name="alert-circle-outline" size={18} color={t.helperWarn} />}
            </View>
          )}
          <View style={styles.noteBody}>
            <View style={styles.noteTopRow}>
              <Text numberOfLines={1} style={[styles.noteTitle, { color: t.text }]}>
                {n.title}
              </Text>
              <Text style={[styles.noteTime, { color: t.muted }]}>{n.time}</Text>
            </View>
            <Text style={[styles.noteDesc, { color: isFailed ? t.helperWarn : t.muted }]}>{n.desc}</Text>
          </View>
          {!selectionMode && isIncoming ? (
            <Ionicons name="open-outline" size={15} color={t.muted} style={styles.openHint} />
          ) : null}
        </Animated.View>
      );

      const pressable = (
        <Pressable
          onPress={() => (selectionMode ? toggleSelected(n.id) : openNote(n))}
          onLongPress={() => {
            // Uzun basış da silme modunu açsın — listeden çıkmadan seçime
            // geçmenin alışılmış yolu.
            if (!selectionMode) {
              setSelectionMode(true);
              setSelectedIds(new Set([n.id]));
            }
          }}
          accessibilityRole={selectionMode ? 'checkbox' : 'button'}
          accessibilityState={selectionMode ? { checked } : undefined}
          accessibilityLabel={
            selectionMode
              ? `${n.title}, ${checked ? 'seçili' : 'seçili değil'}`
              : `${n.title}, ${n.desc}, ${n.time}. Açmak için dokun`
          }
          accessibilityActions={selectionMode ? undefined : [{ name: 'dismiss', label: 'Kapat' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'dismiss') dismiss(n.id);
          }}>
          {card}
        </Pressable>
      );

      // Silme modunda kaydırma kapalı: seçim hareketiyle çakışıyor.
      if (selectionMode) return pressable;

      return (
        <Swipeable
          renderRightActions={() => (
            <View style={[styles.deleteAction, { backgroundColor: t.danger }]}>
              <Ionicons name="trash-outline" size={20} color={t.onAccent} />
            </View>
          )}
          onSwipeableOpen={(direction) => {
            if (direction === SwipeDirection.RIGHT) {
              dismiss(n.id);
              forgetSavedFiles([n.fileName]);
            }
          }}>
          {pressable}
        </Swipeable>
      );
    },
    [dismiss, openNote, selectedIds, selectionMode, t, toggleSelected]
  );

  const header = (
    <View style={styles.headerBlock}>
      {reconnecting ? (
        <View style={[styles.banner, { backgroundColor: t.rowBgSel, borderColor: t.helperWarn }]}>
          <ActivityIndicator size="small" color={t.helperWarn} />
          <Text style={[styles.bannerText, { color: t.helperWarn, flexShrink: 1 }]}>
            Sunucuya ulaşılamıyor, tekrar deneniyor…
          </Text>
        </View>
      ) : deviceProblem ? (
        <View
          style={[
            styles.banner,
            { backgroundColor: t.rowBgSel, borderColor: deviceProblem.isFailure ? t.helperWarn : t.border },
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
              style={styles.bannerAction}>
              <Text style={[styles.bannerActionLabel, { color: t.accentText }]}>Ayarla</Text>
            </Pressable>
          ) : deviceProblem.action === 'pair-device' ? (
            <Pressable
              onPress={() => router.push('/pair-device')}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Cihaz eşleştir"
              style={styles.bannerAction}>
              <Text style={[styles.bannerActionLabel, { color: t.accentText }]}>Eşleştir</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={styles.statsRow}>
        <View style={[styles.statCard, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[styles.statValue, { color: t.accentText }]}>{incomingCount}</Text>
          <Text style={[styles.statLabel, { color: t.muted }]}>Gelen dosya</Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[styles.statValue, { color: t.text }]}>
            {devicesLoading && devices.length === 0 ? '…' : devices.length}
          </Text>
          <Text style={[styles.statLabel, { color: t.muted }]}>Bağlı bilgisayar</Text>
        </View>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              accessibilityRole="button"
              accessibilityLabel={`Filtre: ${f}`}
              accessibilityState={{ selected: active }}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              style={[
                styles.filterChip,
                { backgroundColor: active ? t.accent : 'transparent', borderColor: active ? t.accent : t.border },
              ]}>
              <Text style={[styles.filterLabel, { color: active ? t.onAccent : t.muted }]}>{f}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const empty = (() => {
    if (notesError) {
      const p = describeError(notesError);
      return (
        <View style={styles.emptyState}>
          <Ionicons name="alert-circle-outline" size={22} color={t.helperWarn} />
          <Text style={[styles.emptyText, { color: t.helperWarn }]}>{p.message}</Text>
          {p.hint ? <Text style={[styles.emptyHint, { color: t.muted }]}>{p.hint}</Text> : null}
          <Pressable
            onPress={refreshNotes}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Tekrar dene"
            style={[styles.retryBtn, { borderColor: t.accent }]}>
            <Text style={[styles.retryLabel, { color: t.accentText }]}>Tekrar dene</Text>
          </Pressable>
        </View>
      );
    }
    if (unsupported) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="notifications-outline" size={22} color={t.dim} />
          <Text style={[styles.emptyText, { color: t.muted }]}>Bu sunucu geçmiş tutmuyor</Text>
          <Text style={[styles.emptyHint, { color: t.muted }]}>
            Aktarım geçmişi yalnızca masaüstü uygulamasının sunucusunda tutulur
          </Text>
        </View>
      );
    }
    const filtered = notes.length > 0;
    return (
      <View style={styles.emptyState}>
        <Ionicons name={filtered ? 'funnel-outline' : 'notifications-outline'} size={22} color={t.dim} />
        <Text style={[styles.emptyText, { color: t.muted }]}>
          {filtered ? 'Bu filtreye uyan kayıt yok' : 'Henüz aktarım yok'}
        </Text>
        <Text style={[styles.emptyHint, { color: t.muted }]}>
          {filtered ? 'Başka bir filtre dene' : 'Bir cihaz dosya gönderdiğinde burada görünür'}
        </Text>
      </View>
    );
  })();

  const canEnterSelection = notes.length > 0;

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerTitles}>
          <Text style={[styles.title, { color: t.text }]}>Bildirimler</Text>
          <Text style={[styles.subtitle, { color: t.accentText }]}>
            {selectionMode ? `${selectedIds.size} seçildi` : 'Gelen dosyalar ve aktarımlar'}
          </Text>
        </View>
        <View style={styles.headerBtns}>
          {/* Üstteki tuş: normalde silme modunu AÇAR, modda "İptal et"e döner. */}
          {canEnterSelection || selectionMode ? (
            <Pressable
              onPress={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={selectionMode ? 'Silme modunu iptal et' : 'Bildirimleri sil'}
              style={[
                styles.headerBtn,
                {
                  backgroundColor: t.surface,
                  borderColor: selectionMode ? t.accent : t.border,
                  paddingHorizontal: selectionMode ? 12 : 0,
                  width: selectionMode ? undefined : 38,
                },
              ]}>
              {selectionMode ? (
                <Text style={[styles.headerBtnLabel, { color: t.accentText }]}>İptal et</Text>
              ) : (
                <Ionicons name="trash-outline" size={17} color={t.accentText} />
              )}
            </Pressable>
          ) : null}
          <Pressable
            onPress={toggleTheme}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={dark ? 'Açık temaya geç' : 'Koyu temaya geç'}
            style={[styles.headerBtn, { backgroundColor: t.surface, borderColor: t.border, width: 38 }]}>
            <Ionicons name={dark ? 'moon' : 'sunny'} size={18} color={t.accentText} />
          </Pressable>
        </View>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(n) => n.id}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={[styles.content, selectionMode ? { paddingBottom: 100 } : null]}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={Platform.OS !== 'web'}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={9}
        refreshControl={
          // react-native-web RefreshControl'ü DOM'a hiç basmıyor (ölçüldü):
          // masaüstünde aşağı çekerek yenileme diye bir şey yok.
          Platform.OS === 'web' ? undefined : (
            <RefreshControl
              refreshing={pullRefreshing}
              onRefresh={handlePullRefresh}
              tintColor={t.accent}
              colors={[t.accent]}
            />
          )
        }
      />

      {/* Alt çubuk: yalnızca silme modunda. Seçim yoksa Sil tuşu pasif. */}
      {selectionMode ? (
        <View
          style={[
            styles.selectionBar,
            { backgroundColor: t.surface, borderColor: t.border, paddingBottom: insets.bottom + 12 },
          ]}>
          <Text style={[styles.selectionCount, { color: selectedIds.size ? t.accentText : t.muted }]}>
            {selectedIds.size ? `${selectedIds.size} bildirim seçildi` : 'Silinecek bildirimleri seç'}
          </Text>
          <Pressable
            onPress={deleteSelected}
            disabled={selectedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel="Seçili bildirimleri sil"
            accessibilityState={{ disabled: selectedIds.size === 0 }}
            style={[
              styles.deleteBtn,
              {
                backgroundColor: selectedIds.size ? t.danger : t.btnIdle,
                borderColor: selectedIds.size ? 'transparent' : t.btnIdleBorder,
              },
            ]}>
            <Ionicons name="trash-outline" size={17} color={selectedIds.size ? t.onAccent : t.btnIdleFg} />
            <Text style={[styles.deleteBtnLabel, { color: selectedIds.size ? t.onAccent : t.btnIdleFg }]}>Sil</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerTitles: { flex: 1, minWidth: 0 },
  headerBtns: { flexDirection: 'row', gap: 8, flexShrink: 0 },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  headerBtn: {
    height: 38,
    minWidth: 38,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnLabel: { fontSize: 12.5, fontWeight: '800' },
  content: { padding: 20, paddingBottom: 40 },
  headerBlock: { gap: 14, paddingBottom: 14 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  bannerBody: { flex: 1, gap: 2 },
  bannerText: { fontSize: 12, fontWeight: '700' },
  bannerHint: { fontSize: 11, fontWeight: '500' },
  bannerAction: { paddingHorizontal: 4, paddingVertical: 4 },
  bannerActionLabel: { fontSize: 11.5, fontWeight: '800' },
  statsRow: { flexDirection: 'row', gap: 10 },
  statCard: { flex: 1, padding: 14, borderRadius: 16, borderWidth: 1 },
  statValue: { fontSize: 23, fontWeight: '800', letterSpacing: -0.5 },
  statLabel: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, borderWidth: 1.5 },
  filterLabel: { fontSize: 12, fontWeight: '700' },
  noteCard: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, marginBottom: 9, alignItems: 'center' },
  deleteAction: { width: 76, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 9 },
  noteIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 8,
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginLeft: 8,
    marginRight: 8,
  },
  noteBody: { flex: 1, gap: 4 },
  noteTopRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  noteTitle: { fontSize: 13.5, fontWeight: '800', flexShrink: 1 },
  noteTime: { fontSize: 10.5, fontWeight: '700', flexShrink: 0 },
  noteDesc: { fontSize: 11.5, fontWeight: '600' },
  openHint: { flexShrink: 0 },
  emptyState: { alignItems: 'center', gap: 6, paddingVertical: 60 },
  emptyText: { textAlign: 'center', fontSize: 13, fontWeight: '600' },
  emptyHint: { textAlign: 'center', fontSize: 11.5, fontWeight: '500' },
  retryBtn: { marginTop: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 11, borderWidth: 1.5 },
  retryLabel: { fontSize: 12.5, fontWeight: '700' },
  selectionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  selectionCount: { fontSize: 12.5, fontWeight: '700', flexShrink: 1 },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    minHeight: 46,
    borderRadius: 13,
    borderWidth: 1,
    flexShrink: 0,
  },
  deleteBtnLabel: { fontSize: 14, fontWeight: '800' },
});
