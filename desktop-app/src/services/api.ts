/**
 * mobildeki services/api.ts'in masaüstü karşılığı — AYNI dışa aktarılan
 * isim/imza yüzeyini korur (ApiDevice, ApiFileEntry, hata sınıfları, ping/
 * getDevices/getFiles/removeDevice/uploadFiles/downloadFile) ki reused
 * ekranlar (aktarim.tsx, explore.tsx, index.tsx) HİÇ değişmeden çalışsın.
 * Gerçek ağ isteği burada DEĞİL, electron/main/client.ts'te (main process)
 * yapılıyor — renderer sadece IPC ile main'e "şunu yap" diyor. Sebep: main
 * process'te (Node) CORS kısıtı yok, deneme-server da CORS header'ı
 * göndermiyor (API sözleşmesi bu oturumda değiştirilmedi) - renderer'dan
 * doğrudan fetch() atmak CORS'a takılırdı.
 */

export class ApiNotConfiguredError extends Error {
  constructor(message = 'Sunucu adresi ayarlanmamış') {
    super(message);
    this.name = 'ApiNotConfiguredError';
  }
}

export class NotPairedError extends Error {
  constructor(message = 'Cihaz eşleştirilmemiş') {
    super(message);
    this.name = 'NotPairedError';
  }
}

export class Unauthorized401Error extends Error {
  constructor(message = 'Kimlik doğrulama başarısız') {
    super(message);
    this.name = 'Unauthorized401Error';
  }
}

export class ApiUnreachableError extends Error {
  url?: string;
  constructor(message = 'Sunucuya ulaşılamıyor', details?: { url?: string; cause?: unknown }) {
    super(message);
    this.name = 'ApiUnreachableError';
    this.url = details?.url;
    // Altta yatan hata (DNS, bağlantı reddi, zaman aşımı) burada saklanır:
    // hepsi kullanıcıya aynı "sunucuya ulaşılamıyor" olarak görünür, ayrımı
    // ancak bu alan yapabilir. Mobil taraftaki karşılığıyla aynı sözleşme.
    if (details?.cause !== undefined) this.cause = details.cause;
  }
}

export class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

/** Masaüstünde SAF yok, indirme klasörü kullanıcı tarafından seçiliyor. */
export class DownloadFolderNotSetError extends Error {
  constructor(message = 'Önce indirme klasörü seç') {
    super(message);
    this.name = 'DownloadFolderNotSetError';
  }
}

/** Masaüstünde bir izin sistemi yok (yerel dosya yazımı) - sınıf, explore.tsx
 * ile tip uyumluluğu için var ama hiçbir zaman fırlatılmaz. */
export class SharedStoragePermissionDeniedError extends Error {
  constructor(message = 'İzin verilmedi') {
    super(message);
    this.name = 'SharedStoragePermissionDeniedError';
  }
}

/**
 * Kullanıcı isteği bilinçli olarak iptal etti - ağ hatası DEĞİL.
 * Mobil taraftaki karşılığıyla aynı sözleşme (bkz. mobile-app/services/api.ts):
 * ortak context'ler (device-context) bu tipi `instanceof` ile ayırt ediyor.
 */
export class RequestCancelledError extends Error {
  constructor(message = 'İstek iptal edildi') {
    super(message);
    this.name = 'RequestCancelledError';
  }
}

/**
 * Mobilde paylaşılan depolamaya kopyalama bellek sınırını aştığında fırlatılır.
 * Masaüstünde böyle bir sınır yok (dosya doğrudan diske yazılıyor) - sınıf
 * yalnızca ortak hata-metni katmanı (services/error-messages.ts) iki platformda
 * da derlensin diye burada da tanımlı.
 */
export class FileTooLargeToSaveError extends Error {
  constructor(message = 'Dosya bu cihazda kaydedilemeyecek kadar büyük') {
    super(message);
    this.name = 'FileTooLargeToSaveError';
  }
}

export type RetryCallback = (attempt: number, maxAttempts: number) => void;

type IpcErrorBody = { error?: string; url?: string; cause?: string } | null;

/**
 * 401 = sunucudaki token artık geçerli değil (cihaz çıkarılmış, tokens.json
 * sıfırlanmış). Saklanan kimlik bilgisi ARTIK İŞE YARAMIYOR ve silinmezse
 * uygulama kalıcı bir çıkmaza düşüyordu: Dosyalar/Aktarım sonsuza kadar 401
 * veriyor, Sunucu sekmesindeki "bu bilgisayarı eşleştir" kartı ise kimlik
 * bilgisi "var" göründüğü için hiç çıkmıyordu — kullanıcının arayüzden
 * kurtulma yolu yoktu (credentials.json'ı elle silmek gerekiyordu).
 *
 * Mobil taraftaki karşılığı handleUnauthorized(): orada da kimlik bilgisi
 * silinip eşleştirme ekranı açılıyor. Masaüstünde ekran yönlendirmesi yerine
 * kaydı temizliyoruz; Sunucu sekmesi bunu görüp eşleştirme kartını kendisi
 * gösteriyor.
 *
 * Aynı anda başarısız olan birden çok istek temizliği üst üste tetiklemesin
 * diye tek uçuşta birleştiriliyor.
 */
let clearingCredentials: Promise<void> | null = null;

function handleUnauthorized(): void {
  if (clearingCredentials) return;
  clearingCredentials = window.desktop.client
    .clearCredentials()
    .then(() => {})
    .catch(() => {})
    .finally(() => {
      clearingCredentials = null;
    });
}

function throwForIpcError(body: IpcErrorBody): never {
  const errorCode = body?.error;
  if (errorCode === 'not-configured') throw new ApiNotConfiguredError();
  if (errorCode === 'not-paired') throw new NotPairedError();
  if (errorCode === 'unauthorized') {
    handleUnauthorized();
    throw new Unauthorized401Error();
  }
  if (errorCode === 'no-download-folder') throw new DownloadFolderNotSetError();
  if (errorCode === 'unreachable') {
    // url ve cause main process'ten taşınıyor - mobil taraftaki
    // ApiUnreachableError ile aynı teşhis bilgisi burada da mevcut olsun.
    throw new ApiUnreachableError('Sunucuya ulaşılamıyor', { url: body?.url, cause: body?.cause });
  }
  throw new ApiRequestError(0, errorCode ?? 'İşlem başarısız');
}

/**
 * Yeniden deneme mantığı main process'te (client.ts) çalışıyor; burası hem
 * sonucu yorumluyor hem de deneme sırasında gelen 'client:retry' olaylarını
 * çağıranın onRetry geri çağrısına iletiyor.
 *
 * Abonelik yalnızca istek uçuştayken açık: mobildeki sözleşme "bu çağrı
 * yeniden deneniyor" demek, bu yüzden başka bir isteğin denemeleri buraya
 * sızmasın diye istek biter bitmez kapatılıyor.
 */
/**
 * signal: yeniden deneme döngüsü main process'te (client.ts) çalıştığı için
 * isteği gerçekten yarıda kesemiyoruz; iptal edildiğinde sonucu YOK SAYIP
 * RequestCancelledError fırlatıyoruz. Masaüstü genelde localhost/LAN'a
 * bağlandığından mobildeki 29 saniyelik bekleme burada oluşmuyor - sözleşme
 * uyumu için kabul ediliyor.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  onRetry?: RetryCallback,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw new RequestCancelledError();
  const unsubscribe = onRetry
    ? window.desktop.client.onRetry((info) => onRetry(info.attempt, info.maxAttempts))
    : null;
  let result;
  try {
    result = await window.desktop.client.request(method, path, body);
  } finally {
    unsubscribe?.();
  }
  if (signal?.aborted) throw new RequestCancelledError();
  if (result.status === 0) {
    throwForIpcError(result.body as IpcErrorBody);
  }
  if (result.status === 401) {
    handleUnauthorized();
    throw new Unauthorized401Error();
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ApiRequestError(result.status, `İstek başarısız: ${result.status}`);
  }
  return result.body as T;
}

export function ping(onRetry?: RetryCallback, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request('GET', '/ping', undefined, onRetry, signal);
}

export type ApiDevice = {
  id: string;
  name: string;
  pairedAt: string;
  connected: boolean;
  lastSeenAt: string | null;
};

type RawDevice = { deviceId: string; name: string; pairedAt: string; lastSeenAt: string | null; connected: boolean };

function toApiDevice(raw: RawDevice): ApiDevice {
  return { id: raw.deviceId, name: raw.name, pairedAt: raw.pairedAt, connected: raw.connected, lastSeenAt: raw.lastSeenAt };
}

export async function getDevices(onRetry?: RetryCallback, signal?: AbortSignal): Promise<ApiDevice[]> {
  const res = await request<{ ok: boolean; devices: RawDevice[] }>('GET', '/api/devices', undefined, onRetry, signal);
  return res.devices.map(toApiDevice);
}

export type ApiFileEntry = {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  size: number | null;
  modifiedAt: string;
  fileType: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other' | null;
};

export async function getFiles(
  path: string = '/',
  onRetry?: RetryCallback,
  signal?: AbortSignal
): Promise<ApiFileEntry[]> {
  const res = await request<{ path: string; entries: ApiFileEntry[] }>(
    'GET',
    `/api/files?path=${encodeURIComponent(path)}`,
    undefined,
    onRetry,
    signal
  );
  return res.entries;
}

/**
 * Aktarım geçmişi. Masaüstünde bu ekran kendi IPC'sini kullanıyor
 * (window.desktop.transfers) ama paylaşılan notifications-context aynı API
 * yüzeyini bekliyor - iki api.ts'in imzaları birebir aynı kalmalı.
 */
export type ApiTransfer = {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: 'success' | 'failed';
  fileName: string;
  path: string | null;
  sizeBytes: number | null;
  deviceId: string | null;
  deviceName: string | null;
  at: string;
  error?: string;
  savedPath?: string;
};

export class TransfersUnsupportedError extends Error {
  constructor(message = 'Bu sunucuda aktarım geçmişi tutulmuyor') {
    super(message);
    this.name = 'TransfersUnsupportedError';
  }
}

export async function getTransfers(onRetry?: RetryCallback, signal?: AbortSignal): Promise<ApiTransfer[]> {
  try {
    const res = await request<{ ok: boolean; transfers: ApiTransfer[] }>(
      'GET',
      '/api/transfers',
      undefined,
      onRetry,
      signal
    );
    return res.transfers ?? [];
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 501) throw new TransfersUnsupportedError();
    throw e;
  }
}

export async function removeDevice(deviceId: string): Promise<void> {
  await request('DELETE', `/api/devices/${encodeURIComponent(deviceId)}`);
}

/** uri = mutlak dosya yolu (services/sharedStorage.pickFiles'ın döndürdüğü). */
export type UploadFileInput = { uri: string; name: string; mimeType?: string };

export async function uploadFiles(
  files: UploadFileInput[],
  note: string,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  targetPath: string = '/'
): Promise<void> {
  // Ana süreçteki fetch tabanlı yükleme, mobildeki XHR'ın verdiği bayt
  // bazlı ilerlemeyi sağlamıyor - bilinçli bir sadeleştirme (bkz. oturum
  // sonu raporu). Sadece başlangıç/bitiş sinyali veriliyor. 20MB üstü
  // otomatik chunk-upload eşiği de mobile özgü - masaüstü tarafı (genelde
  // aynı LAN/localhost içinde) tek istekte yüklemeye devam ediyor.
  onProgress?.(0, 1);
  const result = await window.desktop.client.uploadFiles(
    files.map((f) => ({ path: f.uri, name: f.name, mimeType: f.mimeType })),
    note,
    targetPath
  );
  if (!result.ok) throwForIpcError({ error: result.error });
  onProgress?.(1, 1);
}

export async function downloadFile(
  fileId: string,
  fileName: string,
  onProgress?: (writtenBytes: number, totalBytes: number) => void
): Promise<string> {
  const unsubscribe = onProgress
    ? window.desktop.client.onDownloadProgress((info) => {
        if (info.fileName === fileName) onProgress(info.writtenBytes, info.totalBytes);
      })
    : null;
  try {
    const result = await window.desktop.client.downloadFile(fileId, fileName);
    if (!result.ok) throwForIpcError({ error: result.error });
    return result.savedPath ?? '';
  } finally {
    unsubscribe?.();
  }
}
