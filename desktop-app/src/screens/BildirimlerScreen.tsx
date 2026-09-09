import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/contexts/theme-context';
import type { TransferRecord } from '../types/desktop';

/**
 * Masaüstüne ÖZEL Bildirimler ekranı — telefondaki
 * mobile-app/app/(tabs)/index.tsx'in yerine App.tsx tarafından monte edilir.
 *
 * Neden ayrı bir ekran: gelen/giden ve başarısız aktarımların eksiksiz
 * kaydını yalnızca gömülü sunucunun çalıştığı bu makine tutabiliyor (bkz.
 * electron/main/transfers.ts). Telefon tarafı bilinçli olarak
 * DEĞİŞTİRİLMEDİ; paylaşılan ekran dosyasına dokunmamak için kopya yerine
 * ayrı bir bileşen yazıldı.
 */

type Filter = 'Tümü' | 'Gelen' | 'Giden' | 'Başarısız';
const FILTERS: Filter[] = ['Tümü', 'Gelen', 'Giden', 'Başarısız'];

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hhmm;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm}`;
}

export default function BildirimlerScreen({
  registerReload,
}: {
  /**
   * Ekran, kendi veri tazeleme fonksiyonunu üst bileşene (App.tsx) verir.
   * Yenile tuşunun dönüş animasyonu bu fonksiyonun promise'ini bekliyor —
   * böylece ikon, liste GERÇEKTEN gelene kadar dönüyor. Önceki "artan sayaç"
   * yaklaşımında tuş yalnızca cihaz listesini bekliyordu; bildirimler henüz
   * yüklenmemişken animasyon çoktan durmuş oluyordu.
   */
  registerReload?: (reload: () => Promise<void>) => void;
}) {
  const insets = useSafeAreaInsets();
  const { dark, toggleTheme, theme: t } = useAppTheme();
  const [records, setRecords] = useState<TransferRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('Tümü');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (typeof window === 'undefined' || !window.desktop) return;
    // try/catch: IPC reddederse yakalanmamış promise reddi oluşuyordu.
    let list: TransferRecord[];
    try {
      list = await window.desktop.transfers.list();
    } catch {
      return;
    }
    setRecords(list);
    // Silinen kayıtların kimlikleri seçimde asılı kalmasın.
    setSelected((prev) => {
      const alive = new Set(list.map((r) => r.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  useEffect(() => {
    reload();
    if (typeof window === 'undefined' || !window.desktop) return;
    return window.desktop.transfers.onChange(reload);
  }, [reload]);

  useEffect(() => {
    registerReload?.(reload);
  }, [registerReload, reload]);

  // Ekran açıkken gelen kayıtlar okunmuş sayılır - kenar çubuğundaki
  // okunmamış rozeti, kullanıcı listeye bakarken şişmeye devam etmesin.
  useEffect(() => {
    const unread = records.filter((r) => r.unread).map((r) => r.id);
    if (unread.length === 0) return;
    const timer = setTimeout(() => window.desktop?.transfers.markRead(unread), 1200);
    return () => clearTimeout(timer);
  }, [records]);

  const visible = useMemo(
    () =>
      records.filter((r) => {
        if (filter === 'Gelen') return r.direction === 'incoming';
        if (filter === 'Giden') return r.direction === 'outgoing';
        if (filter === 'Başarısız') return r.status === 'failed';
        return true;
      }),
    [records, filter]
  );

  // Seçim GÖRÜNÜR listeyle sınırlı kalmalı. Eskiden "Gelen"de seçilen kayıtlar
  // "Giden"e geçilince seçili kalmaya devam ediyordu ve "Sil" ekranda hiç
  // görünmeyen kayıtları da siliyordu. Filtre değişince kapsam dışı kalanları
  // düşürüyoruz.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visibleIds = new Set(visible.map((r) => r.id));
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filter, visible]);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  /**
   * Bir bildirimin işaret ettiği dosya açılabilir mi? Yalnızca TEK bir
   * dosyaya ait, başarılı kayıtlarda anlamlı: başarısız kayıtlarda ortada
   * bir dosya yok, çok dosyalı toplu hata kayıtlarında da yol null.
   */
  const canOpen = (r: TransferRecord): boolean => r.status === 'success' && (!!r.savedPath || !!r.path);

  const [openError, setOpenError] = useState<string | null>(null);

  const openRecord = async (r: TransferRecord) => {
    if (!canOpen(r)) return;
    setOpenError(null);
    try {
      const result = await window.desktop.transfers.openTarget(r.id);
      if (!result.ok) setOpenError(result.error ?? 'Dosya açılamadı');
    } catch {
      setOpenError('Dosya açılamadı');
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visible.forEach((r) => next.delete(r.id));
        return next;
      }
      return new Set([...prev, ...visible.map((r) => r.id)]);
    });
  };

  const [actionError, setActionError] = useState<string | null>(null);

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    try {
      await window.desktop.transfers.remove([...selected]);
      setSelected(new Set());
      setActionError(null);
    } catch {
      // Seçim BİLEREK korunuyor: silme başarısızsa kullanıcı tekrar
      // deneyebilsin, silindi sanmasın.
      setActionError('Silinemedi, tekrar dene');
    }
  };

  const deleteAll = async () => {
    try {
      await window.desktop.transfers.clear();
      setSelected(new Set());
      setActionError(null);
    } catch {
      setActionError('Temizlenemedi, tekrar dene');
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Bildirimler</Text>
          <Text style={[styles.subtitle, { color: t.accent }]}>Gelen, giden ve başarısız aktarımlar</Text>
        </View>
        <Pressable
          onPress={toggleTheme}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={dark ? 'Açık temaya geç' : 'Koyu temaya geç'}
          style={[styles.themeBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Ionicons name={dark ? 'moon' : 'sunny'} size={18} color={t.accent} />
        </Pressable>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.chip,
                { backgroundColor: active ? t.accent : t.surface, borderColor: active ? 'transparent' : t.border },
              ]}>
              <Text style={[styles.chipLabel, { color: active ? t.onAccent : t.muted }]}>{f}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.actionBar, { borderColor: t.border }]}>
        <Pressable
          onPress={toggleAll}
          disabled={visible.length === 0}
          accessibilityRole="button"
          accessibilityLabel={allVisibleSelected ? 'Seçimi kaldır' : 'Tümünü seç'}
          style={styles.actionBtn}>
          <Ionicons
            name={allVisibleSelected ? 'checkbox' : 'square-outline'}
            size={16}
            color={visible.length === 0 ? t.dim : t.accent}
          />
          <Text style={[styles.actionLabel, { color: visible.length === 0 ? t.dim : t.accent }]}>
            {allVisibleSelected ? 'Seçimi kaldır' : 'Tümünü seç'}
          </Text>
        </Pressable>

        <View style={{ flex: 1 }} />

        <Text style={[styles.countLabel, { color: t.muted }]}>
          {selected.size > 0 ? `${selected.size} seçili` : `${visible.length} kayıt`}
        </Text>

        <Pressable
          onPress={deleteSelected}
          disabled={selected.size === 0}
          accessibilityRole="button"
          accessibilityLabel="Seçilenleri sil"
          style={styles.actionBtn}>
          <Ionicons name="trash-outline" size={16} color={selected.size === 0 ? t.dim : t.helperWarn} />
          <Text style={[styles.actionLabel, { color: selected.size === 0 ? t.dim : t.helperWarn }]}>Sil</Text>
        </Pressable>

        <Pressable
          onPress={deleteAll}
          disabled={records.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Geçmişi temizle"
          style={styles.actionBtn}>
          <Ionicons name="close-circle-outline" size={16} color={records.length === 0 ? t.dim : t.muted} />
          <Text style={[styles.actionLabel, { color: records.length === 0 ? t.dim : t.muted }]}>Tümünü temizle</Text>
        </Pressable>
      </View>

      {actionError || openError ? (
        <View style={[styles.errorBar, { backgroundColor: t.rowBgSel, borderColor: t.helperWarn }]}>
          <Ionicons name="alert-circle-outline" size={15} color={t.helperWarn} />
          <Text style={[styles.errorText, { color: t.helperWarn }]}>{actionError ?? openError}</Text>
        </View>
      ) : null}

      {/* FlatList (ScrollView değil): geçmiş 500 kayda kadar büyüyebiliyor ve
          hepsini birden çizmek kaydırmayı gözle görülür yavaşlatıyordu.
          FlatList yalnızca görünür pencereyi çiziyor. */}
      <FlatList
        data={visible}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        initialNumToRender={20}
        windowSize={11}
        removeClippedSubviews={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="notifications-off-outline" size={30} color={t.dim} />
            <Text style={[styles.emptyText, { color: t.muted }]}>
              {records.length === 0 ? 'Henüz aktarım yok' : 'Bu filtreye uyan kayıt yok'}
            </Text>
          </View>
        }
        renderItem={({ item: r }) => {
          {
            const isSel = selected.has(r.id);
            const failed = r.status === 'failed';
            const incoming = r.direction === 'incoming';
            const iconName = failed
              ? 'alert-circle'
              : incoming
                ? 'arrow-down-circle'
                : 'arrow-up-circle';
            const iconColor = failed ? t.helperWarn : t.accent;
            const openable = canOpen(r);
            return (
              // Satırın GÖVDESİ dosyayı açar, kutucuk seçimi değiştirir.
              // İkisi ayrı Pressable: tek bir "tıkla = seç" davranışında
              // kullanıcı bildirimden dosyaya ulaşamıyordu.
              <Pressable
                onPress={() => (openable ? void openRecord(r) : toggleOne(r.id))}
                accessibilityRole="button"
                accessibilityLabel={
                  openable
                    ? `${r.fileName} dosyasını aç`
                    : `${incoming ? 'Gelen' : 'Giden'} ${r.fileName}`
                }
                style={[
                  styles.row,
                  {
                    backgroundColor: isSel ? t.rowBgSel : t.surface,
                    borderColor: isSel ? t.accent : t.border,
                    cursor: openable ? ('pointer' as const) : ('auto' as const),
                  },
                ]}>
                <Pressable
                  onPress={() => toggleOne(r.id)}
                  hitSlop={8}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSel }}
                  accessibilityLabel={isSel ? `${r.fileName} seçimini kaldır` : `${r.fileName} kaydını seç`}>
                  <Ionicons name={isSel ? 'checkbox' : 'square-outline'} size={17} color={isSel ? t.accent : t.dim} />
                </Pressable>
                <Ionicons name={iconName} size={19} color={iconColor} />
                <View style={styles.rowBody}>
                  <View style={styles.rowTop}>
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: t.text }]}>
                      {r.fileName}
                    </Text>
                    {r.unread ? <View style={[styles.unreadDot, { backgroundColor: t.accent }]} /> : null}
                  </View>
                  <Text numberOfLines={1} style={[styles.rowSub, { color: failed ? t.helperWarn : t.muted }]}>
                    {failed
                      ? `Başarısız — ${r.error ?? 'bilinmeyen hata'}`
                      : [
                          incoming ? 'Gelen' : 'Giden',
                          r.deviceName ?? (r.deviceId ? r.deviceId.slice(0, 8) : 'bilinmeyen cihaz'),
                          formatSize(r.sizeBytes),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </Text>
                  {r.savedPath ? (
                    <Text numberOfLines={1} style={[styles.rowPath, { color: t.dim }]}>
                      {r.savedPath}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.rowTime, { color: t.dim }]}>{formatTime(r.at)}</Text>
              </Pressable>
            );
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  themeBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingTop: 16 },
  chip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  chipLabel: { fontSize: 11.5, fontWeight: '700' },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4 },
  actionLabel: { fontSize: 11.5, fontWeight: '700' },
  countLabel: { fontSize: 11.5, fontWeight: '600', marginRight: 6 },
  content: { padding: 16, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowTitle: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  unreadDot: { width: 7, height: 7, borderRadius: 999 },
  rowSub: { fontSize: 11, fontWeight: '500' },
  rowPath: { fontSize: 10, fontWeight: '500' },
  rowTime: { fontSize: 10.5, fontWeight: '600' },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginHorizontal: 20,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 10,
  },
  errorText: { fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 60 },
  emptyText: { fontSize: 12.5, fontWeight: '600' },
});
