import type { Server } from 'node:http';
import { appendFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, Notification } from 'electron';
import { describeServerError } from './serverErrors';
// Rollup'ın CJS->ESM statik named-export analizi, deneme-server'ın tsc çıktısındaki
// (ör. "exports.config = void 0" - tsc'nin export edilen değişkenler için standart
// hoisting deseni - sonra ayrı bir satırda gerçek atama) bazı ihraç şekillerini
// güvenilir tespit edemiyordu ("X is not exported by ... .js"). Namespace import
// (Rollup'ın HER ZAMAN doğru çalışan CJS interop yolu) + property erişimi, TÜM
// deneme-server modülleri için tutarlılık adına burada kullanılıyor.
import * as ConfigModule from 'deneme-server/config';
import * as ServerModule from 'deneme-server';
import * as PairModule from 'deneme-server/pair';
import * as MessagesModule from 'deneme-server/messages';
import { settings } from './settings';
import { addTransfer, listTransfersForRemote } from './transfers';
import { broadcastToWindows } from './broadcast';
import { deliverToDownloadFolder } from './deliver';

const config = ConfigModule.config;
const { createApp, runStartupCleanup } = ServerModule;
const { pairDevice, listDevicesWithStatus, removeDeviceCompletely, DEVICE_ID_PATTERN } = PairModule;
const { listMessages, deleteMessage } = MessagesModule;

let httpServer: Server | null = null;

/**
 * 'stopping' AYRI bir durum olmak zorunda: kapanış anlık değil (açık
 * bağlantıların bitmesi beklenir). Eskiden stopServer durumu ancak
 * beklemeden SONRA 'stopped' yapıyordu, dolayısıyla bekleme boyunca durum
 * hâlâ 'running' ama httpServer null oluyordu ve arayüz bunu
 * "Çalışıyor: undefined:undefined" diye yazıyordu.
 */
export type ServerLifecycleState = 'stopped' | 'stopping' | 'starting' | 'running' | 'retrying' | 'failed';

export type ServerStatus = {
  state: ServerLifecycleState;
  running: boolean;
  host?: string;
  port?: number;
  /** Sadece state === 'retrying' iken dolu: kaçıncı otomatik deneme bekleniyor/sürüyor. */
  retryAttempt?: number;
  maxRetries?: number;
  /** state 'retrying' ya da 'failed' iken son hatanın kullanıcı-dostu Türkçe açıklaması. */
  lastError?: string;
};

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

let lifecycleState: ServerLifecycleState = 'stopped';
let retryAttempt = 0;
let retryTimer: NodeJS.Timeout | null = null;
let lastError: string | undefined;

/**
 * Her başlat/durdur/yeniden başlat isteği bir "işlem" numarası alır. Geç
 * biten bir işlem, kendisinden sonra başlamış bir işlemin durumunu EZEMEZ.
 *
 * Gerçek gözlem: askıda kalmış bir bağlantı yüzünden geciken bir stop,
 * aradan geçen ve BAŞARIYLA çalışmaya başlamış bir sunucunun üstüne
 * "durum -> stopped" yazdı (server-lifecycle.log'da 11:30:59 running,
 * 11:31:40 stopped). Arayüz sunucuyu kapalı sanıyordu.
 */
let currentOperation = 0;

function beginOperation(): number {
  clearRetryTimer();
  retryAttempt = 0;
  return ++currentOperation;
}

function isCurrentOperation(op: number): boolean {
  return op === currentOperation;
}

export function serverStatus(): ServerStatus {
  return {
    state: lifecycleState,
    running: httpServer !== null,
    host: httpServer ? config.host : undefined,
    port: httpServer ? config.port : undefined,
    ...(lifecycleState === 'retrying' ? { retryAttempt, maxRetries: MAX_RETRIES } : {}),
    ...((lifecycleState === 'retrying' || lifecycleState === 'failed') && lastError ? { lastError } : {}),
  };
}

function broadcastStatus(): void {
  const status = serverStatus();
  broadcastToWindows('server:status-changed', status);
}

/** Paketlenmiş .exe'de console.log hiçbir yere gitmiyor (bağlı bir terminal
 * yok) - render-debug.log/crash.log'un AYNI userData deseniyle, durum
 * makinesi geçişlerini de dosyaya yazıyoruz ki retry/failed döngüsü
 * paketli halde de gözlemlenebilsin. */
function logLifecycle(line: string): void {
  try {
    const logPath = path.join(app.getPath('userData'), 'server-lifecycle.log');
    appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
  } catch {
    // en son çare bir teşhis aracı - kendisi başarısız olursa sessizce yut
  }
}

function setState(next: ServerLifecycleState): void {
  lifecycleState = next;
  const suffix = next === 'retrying' ? ` (deneme ${retryAttempt}/${MAX_RETRIES})` : '';
  const line = `durum -> ${next}${suffix}`;
  console.log(`[server] ${line}`);
  logLifecycle(line);
  broadcastStatus();
}

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function notifyFailure(message: string): void {
  logLifecycle(`native bildirim tetiklendi: "${message}" (Notification.isSupported()=${Notification.isSupported()})`);
  if (!Notification.isSupported()) return;
  new Notification({ title: 'Sunucu durdu', body: message }).show();
}

/** Bir dinleme hatası ya da beklenmedik kapanmadan sonra çağrılır. 3 denemeye
 * kadar ARTAN ARALIKLA (2s → 5s → 10s) attemptStart()'ı tekrar dener; 3'ü de
 * başarısız olursa 'failed' durumuna geçip (hem uygulama içi toast hem de
 * native bildirim ile) kullanıcıyı manuel "Yeniden Başlat"a yönlendirir. */
function scheduleRetryOrFail(message: string, op: number): void {
  if (!isCurrentOperation(op)) return;
  lastError = message;

  if (retryAttempt >= MAX_RETRIES) {
    setState('failed');
    notifyFailure(message);
    return;
  }

  const delay = RETRY_DELAYS_MS[retryAttempt];
  retryAttempt += 1;
  setState('retrying');
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // Otomatik deneme aynı işlemin devamı - araya kullanıcı bir istek
    // sokmuşsa (op değişmişse) attemptStart kendi içinde sessizce çıkar.
    void attemptStart(op);
  }, delay);
}

/**
 * Depo klasörünün hâlâ orada olduğunu düzenli aralıklarla kontrol eder.
 *
 * Neden: depo klasörü silinir ya da harici disk çıkarılırsa sunucu SOKETİ
 * ayakta kalıyor, /ping 200 dönüyor ve arayüz "Çalışıyor" demeye devam
 * ediyordu; oysa her dosya işlemi 503 veriyordu. Durum makinesi bu duruma
 * hiç tepki vermiyor, native bildirim de çıkmıyordu — describeServerError
 * içindeki hazır ENOENT mesajı hiçbir zaman kullanılmıyordu.
 */
const STORAGE_WATCH_INTERVAL_MS = 15_000;
let storageWatchTimer: NodeJS.Timeout | null = null;

function stopStorageWatch(): void {
  if (storageWatchTimer) {
    clearInterval(storageWatchTimer);
    storageWatchTimer = null;
  }
}

function startStorageWatch(op: number): void {
  stopStorageWatch();
  storageWatchTimer = setInterval(() => {
    void (async () => {
      if (!isCurrentOperation(op) || lifecycleState !== 'running') return;
      const root = config.storageRoot;
      try {
        const stats = await stat(root);
        if (stats.isDirectory()) return;
      } catch {
        // aşağıdaki kayıp-depo yoluna düş
      }
      stopStorageWatch();
      logLifecycle(`depo klasörü kayboldu: ${root}`);
      const message = describeServerError({ code: 'ENOENT' } as NodeJS.ErrnoException, {
        port: config.port,
        storageRoot: root,
      });
      const server = httpServer;
      httpServer = null;
      lastError = message;
      setState('failed');
      notifyFailure(message);
      if (server) {
        try {
          server.close();
        } catch {
          // zaten kapanmış olabilir
        }
      }
    })();
  }, STORAGE_WATCH_INTERVAL_MS);
  // Uygulamanın kapanmasını bu zamanlayıcı engellememeli.
  storageWatchTimer.unref?.();
}

/**
 * Kapanışın ASLA süresiz beklememesi için üst sınır. server.close() yalnızca
 * yeni bağlantı kabulünü durdurur; açık bağlantıların KENDİLİĞİNDEN kapanmasını
 * bekler. Askıda kalmış bir indirmede (telefon yavaş bağlantıda büyük dosya
 * çekerken) bu asla olmuyordu: ölçümde stop() 20 saniyeden fazla çözülmedi,
 * arayüzdeki dönen gösterge kalıcı olarak takıldı ve hem "Durdur/Başlat" hem
 * "Yeniden Başlat" devre dışı kaldı. will-quit de aynı çağrıyı beklediğinden
 * uygulama tepsiden çıkışta hiç kapanamıyordu.
 */
const SERVER_CLOSE_TIMEOUT_MS = 3000;

async function closeHttpServerIfRunning(): Promise<void> {
  const server = httpServer;
  httpServer = null;
  if (!server) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // Zaman aşımında açık bağlantıları zorla düşür - aksi hâlde close()
    // geri çağırması hiç gelmez.
    const timer = setTimeout(() => {
      logLifecycle(`kapanış ${SERVER_CLOSE_TIMEOUT_MS} ms'de bitmedi, açık bağlantılar zorla kapatılıyor`);
      try {
        server.closeAllConnections();
      } catch {
        // Node sürümü desteklemiyorsa yapacak bir şey yok; yine de devam et.
      }
      finish();
    }, SERVER_CLOSE_TIMEOUT_MS);

    server.close(() => finish());
    // Boşta bekleyen keep-alive bağlantıları hemen bırakılabilir; bu, normal
    // durumda kapanışı ~5 sn'lik keepAliveTimeout'u beklemekten kurtarıyor.
    try {
      server.closeIdleConnections();
    } catch {
      // isteğe bağlı optimizasyon
    }
  });
}

async function attemptStart(op: number): Promise<{ ok: boolean; error?: string }> {
  if (!isCurrentOperation(op)) return { ok: false, error: 'Başka bir işlem araya girdi' };
  const storageRoot = settings.get('storageRoot');
  if (!storageRoot) {
    // Eksik depo klasörü bir "hata" değil, bir ön koşul - denemek hiçbir şeyi
    // değiştirmeyeceğinden (kullanıcı klasör seçene kadar) burada backoff'lu
    // otomatik denemeye GİRMİYORUZ, doğrudan 'failed' - kullanıcı hemen ne
    // yapması gerektiğini görsün.
    const message = 'Önce Sunucu sekmesinden bir depo klasörü seç';
    lastError = message;
    setState('failed');
    return { ok: false, error: message };
  }

  config.storageRoot = storageRoot;
  config.port = settings.get('port');
  config.host = '0.0.0.0';
  config.onTransfer = handleTransferEvent;
  // GET /api/transfers ucunu açar: telefon da aynı gelen/giden/başarısız
  // geçmişini okuyabilsin diye. Kaydın tek sahibi bu makine.
  // listTransfers DEĞİL listTransfersForRemote: uzak istemcilere bu makinenin
  // mutlak dosya yolları (savedPath) gönderilmemeli - bkz. transfers.ts.
  config.getTransfers = listTransfersForRemote;

  await runStartupCleanup();
  const expressApp = createApp();

  return new Promise((resolve) => {
    // GERÇEK KANITLA BULUNDU (server-lifecycle.log, aynı-runtime EADDRINUSE
    // testi): Windows'ta bazen 'listening' event'i, hemen ardından (~1ms
    // içinde) gelen GERÇEK bir EADDRINUSE'dan ÖNCE fırlıyor - bu, bu gece
    // defalarca gözlemlenen Windows port-bind tuhaflığının bir başka
    // yüzü. Bunu ham haliyle güvenip 'running'e HEMEN commit etmek (retry
    // sayacını sıfırlamak) ölçüldü: sunucu o anda GERÇEKTE istek
    // karşılamıyor (curl ile doğrulandı, bağlantı reddediliyor) - yani
    // 'running' sinyali YALANDI. Kısa bir "grace period" (150ms, gözlenen
    // ~1ms gecikmenin 150 katı) bekleyip, o sürede gerçek bir 'error'
    // gelmezse ancak O ZAMAN kalıcı 'running' sayıyoruz. Çakışmasız normal
    // başlangıçta bu gecikme kullanıcı için farkedilmez.
    let resolved = false;
    let graceTimer: NodeJS.Timeout | null = null;

    const finalizeRunning = () => {
      if (resolved) return;
      resolved = true;
      // Araya yeni bir işlem girmişse (kullanıcı bu arada Durdur'a bastıysa)
      // bu soketi sahiplenmiyoruz - açık bırakmak portu işgal ederdi.
      if (!isCurrentOperation(op)) {
        server.close();
        resolve({ ok: false, error: 'Başka bir işlem araya girdi' });
        return;
      }
      httpServer = server;
      lastError = undefined;
      retryAttempt = 0;
      clearRetryTimer();
      setState('running');
      startStorageWatch(op);
      resolve({ ok: true });
    };

    const server = expressApp
      .listen(config.port, config.host, () => {
        graceTimer = setTimeout(finalizeRunning, 150);
      })
      .on('error', (err: NodeJS.ErrnoException) => {
        if (resolved) {
          // 'running' zaten grace period'ı geçip kesinleşmiş - bu artık
          // gerçek bir "beklenmedik kapanma/hata" senaryosu, server.on('close', ...)
          // ayrıca ele alıyor.
          console.error(`[server] running sonrası gecikmeli hata: ${err.code ?? '(kod yok)'} - ${err.message}`);
          logLifecycle(`running sonrası gecikmeli hata: ${err.code ?? '(kod yok)'} - ${err.message}`);
          return;
        }
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        resolved = true;
        httpServer = null;
        console.error(`[server] listen hatası: ${err.code ?? '(kod yok)'} - ${err.message}`);
        logLifecycle(`listen hatası: ${err.code ?? '(kod yok)'} - ${err.message}`);
        // 'listening' fırlamış ama ardından hata gelmişse soket bağlanmış
        // olabilir; kapatmazsak portu KENDİ terk edilmiş dinleyicimiz işgal
        // eder ve sonraki deneme kendi kendine EADDRINUSE alır.
        try {
          server.close();
        } catch {
          // hiç bağlanamamışsa zaten kapalı
        }
        const message = describeServerError(err, { port: config.port, storageRoot: config.storageRoot });
        scheduleRetryOrFail(message, op);
        resolve({ ok: false, error: message });
      });

    // 'close', hem stopServer()/restartServer()'ın KENDİ isteğiyle kapatmasında
    // hem de gerçekten beklenmedik bir kapanmada tetiklenir. stopServer() ve
    // restartServer() httpServer'ı null'layıp state'i close'dan ÖNCE
    // değiştirdiğinden, buraya "hâlâ running ve hâlâ bu server nesnesi"
    // durumunda gelinmesi SADECE beklenmedik kapanma anlamına gelir.
    server.on('close', () => {
      if (lifecycleState === 'running' && httpServer === server) {
        httpServer = null;
        scheduleRetryOrFail('Sunucu beklenmedik şekilde kapandı', op);
      }
    });
  });
}

export async function startServer(): Promise<{ ok: boolean; error?: string }> {
  if (httpServer) return { ok: true };
  const op = beginOperation();
  setState('starting');
  return attemptStart(op);
}

export async function stopServer(): Promise<void> {
  const op = beginOperation();
  // Durum ÖNCE 'stopping' oluyor: kapanış anlık değil ve bekleme boyunca
  // arayüzün "Çalışıyor" demesi (üstelik host/port undefined'ken) yanlıştı.
  setState('stopping');
  stopStorageWatch();
  await closeHttpServerIfRunning();
  if (isCurrentOperation(op)) setState('stopped');
}

/** Sayacı sıfırlayıp anında yeniden dener - bekleyen bir otomatik deneme
 * varsa iptal eder. 'failed'/'retrying'/'running' her durumdan çağrılabilir. */
export async function restartServer(): Promise<{ ok: boolean; error?: string }> {
  const op = beginOperation();
  setState('stopping');
  stopStorageWatch();
  await closeHttpServerIfRunning();
  if (!isCurrentOperation(op)) return { ok: false, error: 'Başka bir işlem araya girdi' };
  setState('starting');
  return attemptStart(op);
}

/**
 * Process düzeyinde son çare güvenlik ağı - TAM İZOLASYON DEĞİL. Node'un
 * resmi tavsiyesi uncaughtException sonrası süreci güvenilmez sayıp
 * KAPATMAKTIR; burada bunun yerine devam etmeyi seçiyoruz çünkü ana süreç
 * hem Electron UI'ını hem gömülü HTTP sunucusunu barındırıyor - süreci
 * gerçekten kapatmak tüm pencereyi/tray'i de öldürür. Bu listener'ı
 * eklemek Node'un varsayılan fatal-error davranışını (process'i sonlandırma)
 * TÜM ana süreç için devre dışı bırakır - yalnızca sunucuyla ilgili
 * hatalar için değil. Best-effort: hatayı logla; sunucu o an 'running'
 * idiyse aynı backoff'lu kurtarma mekanizmasını tetikle. Hata sunucu
 * dışından (renderer, IPC, Electron'un kendisi) geliyorsa bu hiçbir şeyi
 * düzeltmeyebilir - sadece "sunucu bir fs/network hatasıyla çöktüyse en
 * azından kendi kendine toparlansın" senaryosunu iyileştirir.
 */
/** crash.log'a tek satır ekler - userData altında (kullanıcının depo klasörü
 * değil, uygulamanın kendi ayar/veri klasörü). ek bağımlılık yok, senkron
 * appendFileSync yeterli: bu zaten en son çare bir hata yolu, burada bir
 * async akışın kendisi de başarısız olabileceğinden basit tutuluyor. */
function logCrashToFile(err: unknown): void {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    const timestamp = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? '(stack yok)' : '(stack yok - Error değil)';
    appendFileSync(logPath, `[${timestamp}] ${message}\n${stack}\n\n`, 'utf-8');
  } catch (logErr) {
    console.error('[server] crash.log yazılamadı:', logErr);
  }
}

/**
 * Hatanın sunucuyla ilgisi var mı? Yalnızca varsa sunucuyu düşürüp yeniden
 * başlatıyoruz.
 *
 * Neden gerekli: bu kanca ana sürecin TAMAMINI kapsıyor (renderer IPC
 * handler'ları, multer geri çağırmaları, ilgisiz kütüphaneler). Eskiden
 * herhangi bir yerdeki yakalanmamış tek bir promise reddi bile, sunucuyla
 * hiçbir ilgisi olmasa da, çalışan sunucuyu kapatıp backoff'lu yeniden
 * başlatma döngüsüne sokuyordu - sürmekte olan aktarımlar kesiliyordu.
 * Artık yalnızca ağ/dosya sistemi kaynaklı, sunucunun gerçekten
 * etkilenebileceği hata kodlarında müdahale ediyoruz; diğer her şey
 * yalnızca crash.log'a yazılıyor.
 */
const SERVER_RELATED_ERROR_CODES = new Set([
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'EIO',
]);

function isServerRelatedFault(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && SERVER_RELATED_ERROR_CODES.has(code);
}

function handleProcessLevelFault(err: unknown): void {
  console.error('[server] beklenmeyen process hatası:', err);
  logCrashToFile(err);
  if (lifecycleState !== 'running') return;
  if (!isServerRelatedFault(err)) {
    logLifecycle(`sunucu dışı hata yut: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const nodeErr = err as NodeJS.ErrnoException;
  const message = describeServerError(nodeErr, { port: config.port, storageRoot: config.storageRoot });

  const server = httpServer;
  httpServer = null;
  stopStorageWatch();
  scheduleRetryOrFail(message, currentOperation);
  if (server) {
    try {
      server.close();
    } catch {
      // zaten kapanmış olabilir
    }
  }
}

process.on('uncaughtException', handleProcessLevelFault);
process.on('unhandledRejection', handleProcessLevelFault);

/** Uygulama açıldığında (Windows autostart'la ya da elle fark etmez),
 * kullanıcının "autoStartServer" tercihi açıksa ve bir depo klasörü
 * seçilmişse gömülü sunucuyu kendiliğinden başlatır. */
export async function autoStartIfNeeded(): Promise<void> {
  if (settings.get('autoStartServer') && settings.get('storageRoot')) {
    await startServer();
  }
}

/**
 * Aşağıdaki üç fonksiyon, deneme-server'ın HTTP route'unun (routes/devices.ts)
 * kullandığı AYNI paylaşılan fonksiyonları doğrudan (HTTP/auth katmanından
 * geçmeden) çağırır — aynı süreç içindeki yerel yönetim paneli için, ayrı bir
 * "kendi kendine eşleşme" gerekmiyor. Sunucu çalışmıyorsa bile devices.json/
 * tokens.json üzerinde çalışabilirler (dosya tabanlı, HTTP sunucusundan bağımsız).
 */
export async function pairNewDevice(name: string): ReturnType<typeof pairDevice> {
  const result = await pairDevice(name);
  invalidateDeviceNameCache();
  return result;
}

export async function listPairedDevices(): ReturnType<typeof listDevicesWithStatus> {
  return listDevicesWithStatus();
}

/**
 * Cihaz kimliği -> ad eşlemesi. Bildirim listesinde ham UUID yerine cihazın
 * kendi adını yazabilmek için; eşleştirme listesi nadiren değiştiğinden kısa süreli
 * önbellek yeterli (silinen bir cihazın adı en fazla bu kadar süre eski kalır).
 */
let deviceNameCache: Map<string, string> | null = null;

/**
 * Önbellek artık ZAMANLA değil, OLAYLA geçersizleşiyor: eşleştirme listesi
 * yalnızca bu süreçteki pairDevice/removeDevice ile değişebildiğinden
 * (dosyayı dışarıdan kimse düzenlemiyor), süreli bir TTL yoğun aktarımda
 * her düşüşte devices.json'ı boş yere yeniden okutuyordu.
 */
function invalidateDeviceNameCache(): void {
  deviceNameCache = null;
}

async function resolveDeviceName(deviceId: string | null): Promise<string | null> {
  if (!deviceId) return null;
  if (!deviceNameCache) {
    try {
      const devices = await listDevicesWithStatus();
      deviceNameCache = new Map(devices.map((d) => [d.deviceId, d.name]));
    } catch {
      return null;
    }
  }
  const name = deviceNameCache.get(deviceId);
  if (name !== undefined) return name;
  // Bilinmeyen kimlik: yeni eşleştirilmiş olabilir - bir kez tazeleyip bak.
  try {
    const devices = await listDevicesWithStatus();
    deviceNameCache = new Map(devices.map((d) => [d.deviceId, d.name]));
  } catch {
    return null;
  }
  return deviceNameCache.get(deviceId) ?? null;
}

/**
 * Gömülü sunucudan gelen her aktarım olayını Bildirimler geçmişine yazar;
 * başarıyla GELEN dosyaları ayrıca kullanıcının seçtiği indirme klasörüne
 * teslim eder (bkz. deliver.ts).
 */
function handleTransferEvent(event: ConfigModule.TransferEvent): void {
  // try/catch async gövdenin İÇİNDE olmalı: deneme-server'daki emitTransfer'ın
  // koruması yalnızca SENKRON çağrıyı sarıyor, buradaki async IIFE'nin
  // reddetmesi o korumanın dışında kalıp yakalanmamış bir promise reddi
  // olarak kaçıyordu.
  void (async () => {
    try {
      await recordTransferEvent(event);
    } catch (err) {
      console.error('[transfers] aktarım kaydedilemedi:', err);
    }
  })();
}

async function recordTransferEvent(event: ConfigModule.TransferEvent): Promise<void> {
  const deviceName = await resolveDeviceName(event.deviceId);
  let savedPath: string | undefined;
  if (event.direction === 'incoming' && event.status === 'success') {
    savedPath = (await deliverToDownloadFolder(event.path)) ?? undefined;
  }
  addTransfer({
    direction: event.direction,
    status: event.status,
    fileName: event.fileName,
    path: event.path,
    sizeBytes: event.sizeBytes,
    deviceId: event.deviceId,
    deviceName,
    ...(event.error ? { error: event.error } : {}),
    ...(savedPath ? { savedPath } : {}),
  });
}

export async function removePairedDevice(deviceId: string): Promise<{ ok: boolean; error?: string }> {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return { ok: false, error: 'Geçersiz cihaz kimliği' };
  }
  const removed = await removeDeviceCompletely(deviceId);
  invalidateDeviceNameCache();
  if (!removed) return { ok: false, error: 'Cihaz bulunamadı' };
  return { ok: true };
}

/**
 * Mesajlar (sadece not olarak gönderilen .txt dosyaları) depo klasöründeki
 * gerçek dosyalar - sunucu şu an ÇALIŞMIYOR olsa bile (kullanıcı henüz
 * "Başlat"a basmamış olabilir) erişilebilir olmalı. config.storageRoot
 * normalde sadece startServer() içinde dolduruluyor; burada da (sunucu
 * durumundan bağımsız) elektron-store'daki kayıtlı değerle senkron
 * tutuluyor ki depo klasörü seçilip sunucu hiç başlatılmamış olsa bile
 * mesajlar listelenip silinebilsin.
 */
function syncStorageRootFromSettings(): boolean {
  const storageRoot = settings.get('storageRoot');
  if (!storageRoot) return false;
  config.storageRoot = storageRoot;
  return true;
}

export async function listAllMessages(): ReturnType<typeof listMessages> {
  if (!syncStorageRootFromSettings()) return [];
  return listMessages();
}

export async function removeMessage(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!syncStorageRootFromSettings()) {
    return { ok: false, error: 'Önce Sunucu sekmesinden bir depo klasörü seç' };
  }
  const deleted = await deleteMessage(id);
  if (!deleted) return { ok: false, error: 'Mesaj bulunamadı' };
  return { ok: true };
}
