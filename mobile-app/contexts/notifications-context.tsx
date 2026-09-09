import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getTransfers, TransfersUnsupportedError, type ApiTransfer } from '@/services/api';
import { readJson, writeJson } from '@/services/localStore';

export type NoteKind = 'incoming' | 'outgoing' | 'failed';

export type Note = {
  id: string;
  kind: NoteKind;
  title: string;
  /** Kaydın dosya adı — indirilmiş yerel kopyayı bulmak için kullanılıyor. */
  fileName: string;
  desc: string;
  time: string;
};

type NotificationsContextValue = {
  notes: Note[];
  incomingCount: number;
  /** Sunucu geçmiş tutmuyorsa true — liste boş kalır, bu bir hata değildir. */
  unsupported: boolean;
  loading: boolean;
  /**
   * Geçmiş çekilemediyse asıl hata. Eskiden böyle bir alan YOKTU: her hata
   * sessizce yutuluyor, liste boşaltılıyor ve ekran "Henüz aktarım yok" diyordu
   * — kullanıcı sunucu 500 dönerken bile hiçbir uyarı görmüyordu.
   */
  error: Error | null;
  refresh: () => Promise<void>;
  dismiss: (id: string) => void;
  /** Silme modunda seçilenleri tek seferde kaldırır. */
  dismissMany: (ids: string[]) => void;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/** Kaç saniyede bir arka planda tazelenecek (yalnızca ön plandayken). */
const POLL_INTERVAL_MS = 60_000;

/** Kullanıcının kapattığı kayıtların kalıcı listesi. */
const DISMISSED_KEY = 'dismissedTransfers:v1';
/**
 * Kapatılanlar listesi sınırsız büyümesin: sunucudaki geçmiş de sonsuz değil,
 * en yeni bu kadar kimliği tutmak pratikte yeterli.
 */
const MAX_DISMISSED = 500;

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

/**
 * DİKKAT — direction SUNUCUNUN bakış açısıyla kaydediliyor, telefonun değil.
 * Sunucu kodunda (deneme-server/src/routes/files.ts) yükleme uçları
 * `direction: "incoming"` (dosya sunucuya GELDİ), indirme ucu ise
 * `direction: "outgoing"` (dosya sunucudan ÇIKTI) yazıyor.
 *
 * Telefon açısından bu TERS: telefondan yüklenen dosya sunucuda "incoming"
 * olarak duruyordu ve ekranda "Gelen" yazıyordu — oysa kullanıcı onu
 * GÖNDERMİŞTİ. Burada telefonun bakış açısına çeviriyoruz.
 *
 * Masaüstü bu context'i kullanmıyor (kendi BildirimlerScreen'i var, doğrudan
 * IPC'den okuyor), o yüzden çevirme yalnızca telefonu etkiliyor.
 */
function toNote(t: ApiTransfer): Note {
  const incoming = t.direction === 'outgoing';
  return {
    id: t.id,
    kind: t.status === 'failed' ? 'failed' : incoming ? 'incoming' : 'outgoing',
    title: t.fileName,
    fileName: t.fileName,
    desc:
      t.status === 'failed'
        ? `Başarısız — ${t.error ?? 'bilinmeyen hata'}`
        : [incoming ? 'Gelen' : 'Giden', t.deviceName ?? 'bilinmeyen cihaz', formatSize(t.sizeBytes)]
            .filter(Boolean)
            .join(' · '),
    time: formatTime(t.at),
  };
}

/**
 * Aktarım geçmişini sunucudan okur (GET /api/transfers). Geçmişin tek
 * kaynağı, gömülü sunucuyu çalıştıran bilgisayar — telefon burada yalnızca
 * OKUYUCU. Bu yüzden dismiss yalnızca bu cihazın yerel görünümünü etkiler;
 * sunucudaki kaydı silmez (silme masaüstünden yapılır). Kapatılan kayıtlar
 * artık kalıcı: eskiden yalnızca bellekteydi ve uygulama yeniden açılınca
 * hepsi geri geliyordu.
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());
  const [dismissedLoaded, setDismissedLoaded] = useState(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  // Kapatılanları diskten yükle; ilk tazeleme bunu beklemeli, yoksa kullanıcının
  // daha önce kapattığı kayıtlar bir an için geri görünür.
  useEffect(() => {
    let alive = true;
    readJson<string[]>(DISMISSED_KEY, []).then((ids) => {
      if (!alive) return;
      dismissedRef.current = new Set(ids);
      setDismissedLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    setLoading(true);
    const run = getTransfers()
      .then((list) => {
        setUnsupported(false);
        setError(null);
        setNotes(list.filter((t) => !dismissedRef.current.has(t.id)).map(toNote));
      })
      .catch((e: Error) => {
        const isUnsupported = e instanceof TransfersUnsupportedError;
        setUnsupported(isUnsupported);
        // 501 bir hata değil, desteklenmeyen özellik: liste boşalır ve ekran
        // bunu açıklar. DİĞER hatalarda listeyi KORUYORUZ — bir poll başarısız
        // oldu diye kullanıcının okumakta olduğu kayıtlar kaybolmamalı.
        setError(isUnsupported ? null : e);
        if (isUnsupported) setNotes([]);
      })
      .finally(() => {
        inFlightRef.current = null;
        setLoading(false);
      });
    inFlightRef.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (dismissedLoaded) refresh();
  }, [refresh, dismissedLoaded]);

  // Yalnızca ön plandayken tazele — arka plana geçince zamanlayıcı durur
  // (device-context ile aynı desen).
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) clearInterval(interval);
      interval = setInterval(refresh, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => (s === 'active' ? start() : stop()));
    return () => {
      stop();
      sub.remove();
    };
  }, [refresh]);

  /** Kapatılanları diske yazan ortak yol — dismiss ve dismissMany buradan geçiyor. */
  const persistDismissed = useCallback(() => {
    // En yeni MAX_DISMISSED kimliği tut; Set ekleme sırasını koruduğu için
    // baştan kırpmak en eskileri atar.
    const ids = [...dismissedRef.current];
    const trimmed = ids.length > MAX_DISMISSED ? ids.slice(ids.length - MAX_DISMISSED) : ids;
    if (trimmed.length !== ids.length) dismissedRef.current = new Set(trimmed);
    writeJson(DISMISSED_KEY, trimmed);
  }, []);

  const dismissMany = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      ids.forEach((id) => dismissedRef.current.add(id));
      persistDismissed();
      const set = new Set(ids);
      setNotes((prev) => prev.filter((n) => !set.has(n.id)));
    },
    [persistDismissed]
  );

  const dismiss = useCallback((id: string) => {
    dismissedRef.current.add(id);
    persistDismissed();
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, [persistDismissed]);

  const incomingCount = useMemo(() => notes.filter((n) => n.kind === 'incoming').length, [notes]);

  const value = useMemo<NotificationsContextValue>(
    () => ({ notes, incomingCount, unsupported, loading, error, refresh, dismiss, dismissMany }),
    [notes, incomingCount, unsupported, loading, error, refresh, dismiss, dismissMany]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used within a NotificationsProvider');
  return ctx;
}
