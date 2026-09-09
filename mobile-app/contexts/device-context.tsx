import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { ApiDevice, getDevices, RequestCancelledError } from '@/services/api';

/** Uygulama açıldıktan bu kadar sonra ilk arka plan kontrolü yapılır. */
const INITIAL_CHECK_DELAY_MS = 10_000;
/** Sonrasında bu aralıkla tekrar kontrol edilir (sadece ön plandayken). */
const POLL_INTERVAL_MS = 30 * 60 * 1000;
/** Cihaz eklendiğinde/çıkarıldığında yapılan "burst" kontrol sayısı ve aralığı. */
const BURST_COUNT = 5;
const BURST_INTERVAL_MS = 10_000;

type RefreshOptions = {
  /**
   * Kullanıcının BİLİNÇLİ tetiklemesi (yenile tuşu, aşağı çekerek yenileme,
   * cihaz ekleme sonrası). Uçuşta bir istek olsa bile TAZE bir istek başlatır.
   */
  force?: boolean;
};

type DeviceContextValue = {
  devices: ApiDevice[];
  loading: boolean;
  /** İstek başarısız olduysa asıl hata (tipine göre ekranlar farklı davranır); erişilebiliyorsa null. */
  error: Error | null;
  /** Sunucuya ulaşılamadığı için otomatik yeniden denemeler sürüyor mu. */
  reconnecting: boolean;
  /** Kaçıncı denemede olduğumuz (1 tabanlı) — banda "2/3" yazabilmek için. */
  reconnectAttempt: number;
  /** Elle/pull-to-refresh tetiklemesi için — bittiğinde çözülen bir promise döner. */
  refresh: (opts?: RefreshOptions) => Promise<void>;
  /** Süren isteği iptal eder; kullanıcı 29 saniye beklemek zorunda kalmasın. */
  cancel: () => void;
  /**
   * Bir cihaz eklendiğinde/çıkarıldığında çağrılır: takip eden ~50 saniye
   * boyunca 10sn aralıklarla 5 ek kontrol planlar (yeni durumun sunucu
   * tarafında oturmasını beklemeden, kısa sürede yakalamak için).
   */
  triggerBurstCheck: () => void;
};

const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const [devices, setDevices] = useState<ApiDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  /**
   * refresh() dört ayrı yerden tetiklenebiliyor (ilk yükleme, 30 dakikalık
   * döngü, cihaz değişimi sonrası burst, elle/pull-to-refresh) ve bunlar
   * ÜST ÜSTE BİNEBİLİYOR.
   *
   * ÖNCEKİ TASARIMIN İKİ SORUNU VARDI:
   *
   * 1. Sıra numarası ÖLÜ KODDU. refresh() ilk satırda uçuştaki promise'i
   *    döndürüp çıktığı için aynı anda birden fazla istek hiç var olmuyordu;
   *    requestId her zaman latestRequestRef'e eşitti ve üç karşılaştırma da
   *    ulaşılamazdı. Eski yanıtın taze veriyi ezmesi engelleniyordu ama bunu
   *    sağlayan sıra numarası değil, kilidin kendisiydi.
   *
   * 2. Kilit BAYAT VERİ döndürüyordu. Kullanıcı cihaz ekleyip hemen aşağı
   *    çekerek yenilediğinde, cihaz eklenmeden ÖNCE başlamış bir poll
   *    sürüyorsa o eski isteğin sonucu dönüyor ve yeni cihaz görünmüyordu -
   *    yenileme "çalışmamış" gibi duruyordu.
   *
   * ÇÖZÜM: otomatik tetiklemeler hâlâ birbirini dedupe ediyor (istek yağmuru
   * olmasın), ama force:true olan KULLANICI tetiklemesi her zaman taze bir
   * istek açıyor. Böylece sıra numarası gerçekten iş görüyor: yalnızca EN SON
   * isteğin sonucu state'e yazılıyor.
   */
  const inFlightRef = useRef<Promise<void> | null>(null);
  const latestRequestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback((opts?: RefreshOptions): Promise<void> => {
    if (inFlightRef.current && !opts?.force) return inFlightRef.current;

    // Kullanıcı taze veri istiyorsa süren isteği bırak; yanıtı gelse bile
    // sıra numarası sayesinde yok sayılacak.
    if (opts?.force) abortRef.current?.abort();

    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const run = getDevices((attempt) => {
      if (requestId !== latestRequestRef.current) return;
      setReconnecting(true);
      setReconnectAttempt(attempt);
    }, controller.signal)
      .then((list) => {
        if (requestId !== latestRequestRef.current) return;
        setDevices(list);
        setError(null);
      })
      .catch((e: Error) => {
        if (requestId !== latestRequestRef.current) return;
        // İptal bir hata değil: kullanıcı bilerek durdurdu, elimizdeki veriyi
        // koruyalım ve hata bandı göstermeyelim.
        if (e instanceof RequestCancelledError) return;
        setDevices([]);
        setError(e);
      })
      .finally(() => {
        if (inFlightRef.current === run) inFlightRef.current = null;
        if (requestId !== latestRequestRef.current) return;
        setLoading(false);
        setReconnecting(false);
        setReconnectAttempt(0);
      });

    inFlightRef.current = run;
    return run;
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // İlk yükleme: ekranın boş görünmemesi için uygulama açılır açılmaz,
  // 9b'deki zamanlanmış kontrollerden bağımsız olarak.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Provider kaldırılırken süren istek serbest bırakılsın.
  useEffect(() => () => abortRef.current?.abort(), []);

  // 9b: uygulama ön plandayken 10sn sonra ilk kontrol, sonra her 30 dakikada
  // bir. Arka plana/kilit ekranına geçildiğinde zamanlayıcılar tamamen
  // durur (setTimeout/setInterval temizlenir) — foreground service'ten
  // ayrı, sade bir JS mekanizması. Ön plana dönüldüğünde 10sn+30dk
  // döngüsü baştan başlar (kaçırılan süre telafi edilmez — basit ve
  // öngörülebilir tutmak için bilinçli bir tercih).
  useEffect(() => {
    let initialTimeout: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    function clearTimers() {
      if (initialTimeout) {
        clearTimeout(initialTimeout);
        initialTimeout = null;
      }
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    }

    function startForegroundSchedule() {
      clearTimers();
      initialTimeout = setTimeout(() => {
        refresh();
        interval = setInterval(() => refresh(), POLL_INTERVAL_MS);
      }, INITIAL_CHECK_DELAY_MS);
    }

    if (AppState.currentState === 'active') startForegroundSchedule();

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') startForegroundSchedule();
      else clearTimers();
    });

    return () => {
      clearTimers();
      subscription.remove();
    };
  }, [refresh]);

  // 9a: cihaz eklenme/çıkarılma sonrası burst kontrol.
  const burstTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const triggerBurstCheck = useCallback(() => {
    burstTimeoutsRef.current.forEach(clearTimeout);
    burstTimeoutsRef.current = Array.from({ length: BURST_COUNT }, (_, i) =>
      setTimeout(() => refresh({ force: true }), (i + 1) * BURST_INTERVAL_MS)
    );
  }, [refresh]);

  useEffect(() => {
    const timeouts = burstTimeoutsRef;
    return () => timeouts.current.forEach(clearTimeout);
  }, []);

  const value = useMemo<DeviceContextValue>(
    () => ({ devices, loading, error, reconnecting, reconnectAttempt, refresh, cancel, triggerBurstCheck }),
    [devices, loading, error, reconnecting, reconnectAttempt, refresh, cancel, triggerBurstCheck]
  );

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useDevices() {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error('useDevices must be used within a DeviceProvider');
  return ctx;
}
