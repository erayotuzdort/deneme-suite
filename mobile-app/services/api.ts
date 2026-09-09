import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';

import { getApiBaseUrl } from './apiConfig';
import { rememberSavedFile } from './downloadRegistry';
import { setPairingReason } from './auth-events';
import { clearCredentials, getCredentials, type Credentials } from './credentials';
import { startDownloadNotification, stopDownloadNotification, updateDownloadProgress } from './downloadForegroundService';
import {
  DownloadFolderNotSetError,
  FileTooLargeToSaveError,
  SharedStoragePermissionDeniedError,
  type SaveTarget,
  saveToSharedStorage,
} from './sharedStorage';

export { DownloadFolderNotSetError, FileTooLargeToSaveError, SharedStoragePermissionDeniedError };

const REQUEST_TIMEOUT_MS = 8000;

/** Sunucuya ulaşılamadığı için otomatik yeniden denemeler başladığında çağrılır. */
export type RetryCallback = (attempt: number, maxAttempts: number) => void;

/** Ağ hatası/timeout'ta yapılacak toplam deneme sayısı (ilk deneme dahil). */
const RETRY_ATTEMPTS = 3;
/** Denemeler arası bekleme — agresif olmayan, birkaç saniye arayla. */
const RETRY_DELAY_MS = 2500;

/** Sunucu adresi hiç ayarlanmamış (eşleştirme yapılmamış / ilk açılış). */
export class ApiNotConfiguredError extends Error {
  constructor(message = 'Sunucu adresi ayarlanmamış') {
    super(message);
    this.name = 'ApiNotConfiguredError';
  }
}

/** Cihaz henüz eşleştirilmemiş (deviceId/token güvenli depoda yok). */
export class NotPairedError extends Error {
  constructor(message = 'Cihaz eşleştirilmemiş') {
    super(message);
    this.name = 'NotPairedError';
  }
}

/** Sunucu 401 döndürdü (token geçersiz/silinmiş). */
export class Unauthorized401Error extends Error {
  constructor(message = 'Kimlik doğrulama başarısız') {
    super(message);
    this.name = 'Unauthorized401Error';
  }
}

/** Sunucuya hiç ulaşılamadığını (ağ hatası, timeout) belirtir. */
export class ApiUnreachableError extends Error {
  url?: string;
  constructor(message = 'Sunucuya ulaşılamıyor', details?: { url?: string; cause?: unknown }) {
    super(message);
    this.name = 'ApiUnreachableError';
    this.url = details?.url;
    // Altta yatan hata (ör. cleartext engeli, DNS, bağlantı reddi) burada
    // saklanır: hepsi kullanıcıya aynı "sunucuya ulaşılamıyor" olarak görünür,
    // ayrımı ancak bu alan yapabilir.
    if (details?.cause !== undefined) this.cause = details.cause;
  }
}

/** Sunucu yanıt verdi ama başarısız bir sonuç döndürdü (4xx/5xx, 401 hariç). */
export class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

/**
 * Sunucu 401 döndürdüğünde her çağrı yolunda (request/uploadFiles/downloadFile)
 * tekrar edilen tepki: token artık geçersiz, güvenli depodan silinir ve
 * kullanıcı pasif bir banner yerine doğrudan eşleştirme akışına yönlendirilir.
 * redirecting bayrağı, aynı anda başarısız olan birden çok isteğin (ör. bir
 * poll + sürmekte olan bir yükleme) pair-device'ı üst üste birkaç kez
 * push etmesini önler.
 */
let redirectingToPairing = false;
async function handleUnauthorized(): Promise<void> {
  await clearCredentials();
  if (redirectingToPairing) return;
  redirectingToPairing = true;
  // Ekran, kimlik bilgilerinin NEDEN silindiğini söyleyebilsin diye sebebi
  // bırakıyoruz; aksi hâlde kullanıcı hiçbir açıklama görmeden eşleştirme
  // ekranına düşüyor ve aynı (geçersiz) kodu tekrar yapıştırıyordu.
  setPairingReason('unauthorized');
  router.push('/pair-device');
  setTimeout(() => {
    redirectingToPairing = false;
  }, 3000);
}

async function resolveBaseUrl(): Promise<string> {
  const baseUrl = await getApiBaseUrl();
  if (!baseUrl) throw new ApiNotConfiguredError();
  return baseUrl;
}

async function resolveCredentials(): Promise<Credentials> {
  const credentials = await getCredentials();
  if (!credentials) throw new NotPairedError();
  return credentials;
}

async function buildAuthHeaders(existing?: HeadersInit): Promise<Headers> {
  const { deviceId, token } = await resolveCredentials();
  const headers = new Headers(existing);
  headers.set('X-Device-Id', deviceId);
  headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/**
 * Kullanıcı isteği bilinçli olarak iptal etti - ağ hatası DEĞİL, bu yüzden
 * ekranlar bunu "Sunucuya ulaşılamıyor" diye göstermemeli.
 */
export class RequestCancelledError extends Error {
  constructor(message = 'İstek iptal edildi') {
    super(message);
    this.name = 'RequestCancelledError';
  }
}

/** Dışarıdan gelen iptal sinyalini iç zaman aşımı denetleyicisine bağlar. */
function linkAbort(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort);
  return () => external.removeEventListener('abort', onAbort);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const unlink = linkAbort(signal, controller);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/** İptal edilebilir bekleme - denemeler arası duraklamayı da kesebilmek için. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RequestCancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new RequestCancelledError());
    }
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Sadece ağ hatası/timeout durumunda (ApiUnreachableError), birkaç saniye
 * arayla RETRY_ATTEMPTS kez dener — 401 ve diğer 4xx/5xx yanıtlar geçerli,
 * anlamlı sonuçlardır, bunlarda tekrar denemez. İdempotent uçlar için
 * güvenlidir (ping/getDevices/getFiles: GET, yan etkisiz; removeDevice:
 * DELETE ama idempotent — aynı cihazı iki kez silmenin tek riski, yanıtı
 * kaybolan ilk deneme başarılıyken ikinci denemenin 404 görmesi, bu da
 * zararsız bir ApiRequestError olarak yukarı çıkar). uploadFiles ve
 * downloadFile ayrı, kendi yollarını (XHR/resumable) kullandığından bu
 * fonksiyona uğramaz, tekrarlı gönderim riski yok.
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  onRetry?: RetryCallback,
  signal?: AbortSignal
): Promise<T> {
  const baseUrl = await resolveBaseUrl();
  const headers = await buildAuthHeaders(init?.headers);
  const url = `${baseUrl}${path}`;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new RequestCancelledError();
    if (attempt > 1) {
      onRetry?.(attempt, RETRY_ATTEMPTS);
      await delay(RETRY_DELAY_MS, signal);
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { ...init, headers }, REQUEST_TIMEOUT_MS, signal);
    } catch (e) {
      // Kullanıcının iptali ağ hatası değildir - yeniden deneme YAPMA ve
      // "ulaşılamıyor" hatasına dönüştürme.
      if (signal?.aborted) throw new RequestCancelledError();
      if (attempt === RETRY_ATTEMPTS) throw new ApiUnreachableError('Sunucuya ulaşılamıyor', { url, cause: e });
      continue;
    }
    if (res.status === 401) {
      await handleUnauthorized();
      throw new Unauthorized401Error();
    }
    if (!res.ok) {
      throw new ApiRequestError(res.status, `İstek başarısız: ${res.status}`);
    }
    // Araya giren bir proxy/captive portal HTML döndürebilir; ham SyntaxError
    // hiçbir Api*Error tipine uymadığı için ekranlarda "Sunucuya ulaşılamıyor"
    // olarak görünüyor ve hata ayıklamada yanlış ize sürüklüyordu.
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiRequestError(res.status, 'Sunucu yanıtı okunamadı (geçerli JSON değil)');
    }
  }
  // Buraya ulaşılamaz (döngü ya döner ya da son denemede fırlatır) — TS için.
  throw new ApiUnreachableError('Sunucuya ulaşılamıyor', { url });
}

export type ApiDevice = {
  id: string;
  name: string;
  pairedAt: string;
  /** Sunucuya yakın zamanda istek attı mı (sunucu tarafında hesaplanır). */
  connected: boolean;
  lastSeenAt: string | null;
};

/** Sunucunun GET /api/files?path= ile döndürdüğü tek bir girdi (DirectoryEntry). Tek seviyelidir, çocuk içermez. */
export type ApiFileEntry = {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  size: number | null;
  modifiedAt: string;
  fileType: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other' | null;
};

export function ping(onRetry?: RetryCallback, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request('/ping', undefined, onRetry, signal);
}

/** Sunucunun /api/devices'tan döndürdüğü ham cihaz şekli. */
type RawDevice = {
  deviceId: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  connected: boolean;
};

function toApiDevice(raw: RawDevice): ApiDevice {
  return {
    id: raw.deviceId,
    name: raw.name,
    pairedAt: raw.pairedAt,
    connected: raw.connected,
    lastSeenAt: raw.lastSeenAt,
  };
}

export async function getDevices(onRetry?: RetryCallback, signal?: AbortSignal): Promise<ApiDevice[]> {
  const res = await request<{ ok: boolean; devices: RawDevice[] }>('/api/devices', undefined, onRetry, signal);
  return res.devices.map(toApiDevice);
}

/**
 * Bir cihazı sistemden çıkarır — sahiplik kontrolü yok, herhangi bir
 * eşleştirilmiş cihaz herhangi bir cihazı (kendisi dahil) çıkarabilir.
 * Kendi cihazını çıkarırsa, token'ı sunucuda hemen geçersiz olur; bir
 * sonraki istekte Unauthorized401Error ile "yeniden eşleştir" akışına düşer.
 */
export async function removeDevice(deviceId: string): Promise<void> {
  await request(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
}

/** Bir klasörün doğrudan içeriğini getirir (tek seviye — alt klasörler ayrı bir çağrı gerektirir). */
export async function getFiles(
  path: string = '/',
  onRetry?: RetryCallback,
  signal?: AbortSignal
): Promise<ApiFileEntry[]> {
  const res = await request<{ path: string; entries: ApiFileEntry[] }>(
    `/api/files?path=${encodeURIComponent(path)}`,
    undefined,
    onRetry,
    signal
  );
  return res.entries;
}

/**
 * Sunucudaki aktarım geçmişi (gelen/giden/başarısız). Kaydı yalnızca gömülü
 * sunucuyu çalıştıran bilgisayar tuttuğu için bu uç, o kayıt yoksa 501
 * döner — çağıran taraf bunu "geçmiş yok" olarak ele almalı.
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

/** Sunucu geçmiş tutmuyorsa (501) fırlatılır — hata değil, desteklenmeyen özellik. */
export class TransfersUnsupportedError extends Error {
  constructor(message = 'Bu sunucuda aktarım geçmişi tutulmuyor') {
    super(message);
    this.name = 'TransfersUnsupportedError';
  }
}

export async function getTransfers(onRetry?: RetryCallback, signal?: AbortSignal): Promise<ApiTransfer[]> {
  try {
    const res = await request<{ ok: boolean; transfers: ApiTransfer[] }>('/api/transfers', undefined, onRetry, signal);
    return res.transfers ?? [];
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 501) throw new TransfersUnsupportedError();
    throw e;
  }
}

async function getDownloadUrl(fileId: string): Promise<string> {
  const baseUrl = await resolveBaseUrl();
  return `${baseUrl}/api/files/download?path=${encodeURIComponent(fileId)}`;
}

async function getUploadUrl(): Promise<string> {
  const baseUrl = await resolveBaseUrl();
  return `${baseUrl}/api/files/upload`;
}

export type UploadFileInput = { uri: string; name: string; mimeType?: string };

/**
 * Yüklemede ilerleme DURDUĞUNDA iptal eder - toplam süreye bakmaz.
 *
 * Eskiden `xhr.timeout` kullanılıyordu; o TOPLAM istek süresidir. 15 sn'lik
 * değerle, eşiğin altındaki dosyalar tek istekte gittiği için 5x15 MB'lık bir
 * seçim 40 Mbit/s sürekli hız gerektiriyordu - Tailscale üzerinden mobil
 * veride (tipik 5-30 Mbit/s) yükleme sağlıklı ilerlerken 15. saniyede
 * "Sunucuya ulaşılamıyor" ile kesiliyordu. Üstelik bu yol parçalı yüklemeye
 * girmediğinden her deneme baştan başlıyordu.
 *
 * Doğru ölçüt hız değil, İLERLEME: bayt akmaya devam ettiği sürece ne kadar
 * sürerse sürsün bekleriz. Yükleme bitip sunucu dosyayı yazarken de ilerleme
 * gelmeyeceği için, upload fazı bittiğinde saat daha uzun bir "sunucu yanıtı"
 * penceresine geçer.
 */
const UPLOAD_STALL_TIMEOUT_MS = 20_000;
const UPLOAD_RESPONSE_TIMEOUT_MS = 60_000;

type StallWatchdog = {
  /** Her ilerleme olayında çağrılır; saati sıfırlar. */
  progress: (loaded: number, total: number) => void;
  stop: () => void;
};

/**
 * DİKKAT: yükleme fazının bittiğini `upload`'ın 'load' olayından ÖĞRENEMİYORUZ.
 * React Native'in XMLHttpRequest'i xhr.upload'a YALNIZCA 'progress' olayı
 * gönderiyor (kurulu paketin kaynağında doğrulandı: Libraries/Network/
 * XMLHttpRequest.js — `this.upload` yalnızca __didUploadProgress içinde,
 * ProgressEvent('progress') ile geçiyor; 'load' hiç dispatch edilmiyor).
 * Bu yüzden bitişi ilerleme olayının kendisinden (loaded >= total) çıkarıyoruz —
 * aksi hâlde watchdog dar pencerede kalır ve sunucu dosyayı yazarken 20.
 * saniyede BAŞARILI bir yüklemeyi iptal ederdi.
 */
function createStallWatchdog(onStall: () => void): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let windowMs = UPLOAD_STALL_TIMEOUT_MS;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    stop();
    timer = setTimeout(onStall, windowMs);
  };
  arm();
  return {
    progress: (loaded, total) => {
      // Son bayt da gitti: bundan sonra ilerleme gelmez, sunucunun dosyayı
      // yazıp yanıt vermesini bekliyoruz - daha geniş bir pencereye geç.
      if (total > 0 && loaded >= total) windowMs = UPLOAD_RESPONSE_TIMEOUT_MS;
      arm();
    },
    stop,
  };
}

/** Bu boyutun üstündeki dosyalar tek istekte değil, parça parça (bkz. uploadFileInChunks) yüklenir. */
const CHUNK_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
/** Sunucudaki chunkUploadMiddleware limiti 3MB (parça + multipart ek yükü) - altında güvenli bir pay bırakır. */
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

/** Sunucuya gönderilen dosyaların (küçük olanların) tek istekte yüklendiği uç. */
/**
 * @param onProgress İlerlemeyi 0..1 arası ORAN olarak bildirir, bayt olarak
 *   değil. Sebep: xhr.upload'ın verdiği `loaded` multipart gövdesinin
 *   TAMAMIDIR — sınır işaretçileri, her alanın Content-Disposition başlığı,
 *   `targetPath` ve `note` metni dahil. Bunu ham dosya baytlarına bölmek
 *   %100'ü aşan değerler üretiyordu (küçük dosyada ek yük oransal olarak
 *   büyük olduğu için %171 gibi). Oran, isteğin KENDİ toplamına (e.total)
 *   göre hesaplanıyor; çağıran taraf bunu bildiği ham boyutla ölçekliyor.
 */
async function uploadSmallFiles(
  files: UploadFileInput[],
  note: string,
  targetPath: string,
  onProgress?: (fraction: number) => void
): Promise<void> {
  const uploadUrl = await getUploadUrl();
  const { deviceId, token } = await resolveCredentials();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('X-Device-Id', deviceId);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    let stalled = false;
    const watchdog = createStallWatchdog(() => {
      stalled = true;
      xhr.abort();
      reject(new ApiUnreachableError());
    });
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || e.total <= 0) return;
      watchdog.progress(e.loaded, e.total);
      onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      watchdog.stop();
      if (xhr.status === 401) {
        handleUnauthorized().finally(() => reject(new Unauthorized401Error()));
      } else if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiRequestError(xhr.status, `Yükleme başarısız: ${xhr.status}`));
    };
    xhr.onerror = () => {
      watchdog.stop();
      if (!stalled) reject(new ApiUnreachableError());
    };
    // Toplam süre sınırı YOK - bkz. attachStallWatchdog. İlerleme durursa
    // watchdog iptal eder.
    xhr.timeout = 0;

    const form = new FormData();
    files.forEach((f) => {
      form.append('files', {
        uri: f.uri,
        name: f.name,
        type: f.mimeType ?? 'application/octet-stream',
      } as unknown as Blob);
    });
    form.append('targetPath', targetPath);
    if (note.trim()) form.append('note', note.trim());
    xhr.send(form);
  });
}

// --- 20MB üstü dosyalar için parçalı (chunk) yükleme ---
//
// Sunucudaki /api/files/upload/chunk zaten hazırdı (bkz. deneme-server/src/
// routes/files.ts) ama istemci hiç çağırmıyordu - büyük dosyalar tek istekte
// (uploadSmallFiles) başarıyla gidiyordu, sadece yarıda kesilme durumunda
// baştan başlama dezavantajı vardı. Burada eklenen: dosya boyutu eşiği
// aşıldığında otomatik olarak parçalara bölünüp GET /upload/status ile
// devam ettirilebilir hale getirilmesi.

const PENDING_CHUNK_UPLOADS_KEY = 'chunkUploadSessions:v1';

type PendingChunkUploadMap = Record<string, string>; // sessionKey -> uploadId

function chunkSessionKey(targetPath: string, fileName: string, size: number): string {
  return `${targetPath}::${fileName}::${size}`;
}

async function readPendingUploadMap(): Promise<PendingChunkUploadMap> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_CHUNK_UPLOADS_KEY);
    return raw ? (JSON.parse(raw) as PendingChunkUploadMap) : {};
  } catch {
    return {};
  }
}

async function getPendingUploadId(sessionKey: string): Promise<string | null> {
  const map = await readPendingUploadMap();
  return map[sessionKey] ?? null;
}

async function setPendingUploadId(sessionKey: string, uploadId: string): Promise<void> {
  const map = await readPendingUploadMap();
  map[sessionKey] = uploadId;
  await AsyncStorage.setItem(PENDING_CHUNK_UPLOADS_KEY, JSON.stringify(map));
}

async function clearPendingUploadId(sessionKey: string): Promise<void> {
  const map = await readPendingUploadMap();
  if (!(sessionKey in map)) return;
  delete map[sessionKey];
  await AsyncStorage.setItem(PENDING_CHUNK_UPLOADS_KEY, JSON.stringify(map));
}

function generateUploadId(): string {
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type UploadStatusResponse = {
  ok: boolean;
  uploadId: string;
  fileName: string;
  targetPath: string;
  totalChunks: number;
  receivedChunkIndexes: number[];
};

function getUploadStatus(uploadId: string): Promise<UploadStatusResponse> {
  return request<UploadStatusResponse>(`/api/files/upload/status?uploadId=${encodeURIComponent(uploadId)}`);
}

function chunkByteRange(chunkIndex: number, size: number): { start: number; end: number } {
  const start = chunkIndex * CHUNK_SIZE_BYTES;
  return { start, end: Math.min(start + CHUNK_SIZE_BYTES, size) };
}

function uploadChunkXhr(params: {
  baseUrl: string;
  deviceId: string;
  token: string;
  uploadId: string;
  fileName: string;
  targetPath: string;
  note: string | null;
  chunkIndex: number;
  totalChunks: number;
  blob: Blob;
  /** 0..1 arası oran — bkz. uploadSmallFiles'daki açıklama. */
  onProgress?: (fraction: number) => void;
}): Promise<{ complete: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${params.baseUrl}/api/files/upload/chunk`);
    xhr.setRequestHeader('X-Device-Id', params.deviceId);
    xhr.setRequestHeader('Authorization', `Bearer ${params.token}`);
    let stalled = false;
    const watchdog = createStallWatchdog(() => {
      stalled = true;
      xhr.abort();
      reject(new ApiUnreachableError());
    });
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || e.total <= 0) return;
      watchdog.progress(e.loaded, e.total);
      params.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      watchdog.stop();
      if (xhr.status === 401) {
        handleUnauthorized().finally(() => reject(new Unauthorized401Error()));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiRequestError(xhr.status, `Parça yükleme başarısız: ${xhr.status}`));
        return;
      }
      try {
        const body = JSON.parse(xhr.responseText) as { complete?: boolean };
        resolve({ complete: !!body.complete });
      } catch {
        reject(new ApiRequestError(xhr.status, 'Sunucu yanıtı okunamadı'));
      }
    };
    xhr.onerror = () => {
      watchdog.stop();
      if (!stalled) reject(new ApiUnreachableError());
    };
    // Toplam süre sınırı yok; ilerleme durursa watchdog keser (bkz.
    // createStallWatchdog). Sabit 30 sn, yavaş bağlantıda ilerleyen bir
    // parçayı da kesiyordu.
    xhr.timeout = 0;

    const form = new FormData();
    form.append('uploadId', params.uploadId);
    form.append('fileName', params.fileName);
    form.append('targetPath', params.targetPath);
    if (params.note) form.append('note', params.note);
    form.append('chunkIndex', String(params.chunkIndex));
    form.append('totalChunks', String(params.totalChunks));
    form.append('chunk', params.blob, 'chunk.part');
    xhr.send(form);
  });
}

/**
 * Tek bir büyük dosyayı CHUNK_SIZE_BYTES'lık parçalara bölüp sırayla yükler.
 * Aynı (targetPath, dosya adı, boyut) üçlüsü için daha önce yarıda kalmış bir
 * oturum varsa (AsyncStorage'da uploadId bulunur ve sunucudaki GET /upload/status
 * hâlâ eşleşiyorsa) zaten alınmış parçalar atlanıp kalanından devam edilir.
 */
async function uploadFileInChunks(
  file: UploadFileInput,
  note: string | null,
  targetPath: string,
  onProgress?: (sentBytes: number) => void
): Promise<void> {
  const baseUrl = await resolveBaseUrl();
  const { deviceId, token } = await resolveCredentials();

  const source = new File(file.uri);
  if (!source.exists) throw new ApiRequestError(400, 'Dosya bulunamadı');
  const size = source.size;
  const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE_BYTES));
  const sessionKey = chunkSessionKey(targetPath, file.name, size);

  let uploadId = await getPendingUploadId(sessionKey);
  let receivedIndexes = new Set<number>();

  if (uploadId) {
    try {
      const status = await getUploadStatus(uploadId);
      if (status.fileName === file.name && status.targetPath === targetPath && status.totalChunks === totalChunks) {
        receivedIndexes = new Set(status.receivedChunkIndexes);
      } else {
        uploadId = null;
      }
    } catch {
      uploadId = null;
    }
  }

  if (!uploadId) {
    uploadId = generateUploadId();
    await setPendingUploadId(sessionKey, uploadId);
    receivedIndexes = new Set();
  }

  let sentBytes = 0;
  for (const i of receivedIndexes) {
    const { start, end } = chunkByteRange(i, size);
    sentBytes += end - start;
  }
  onProgress?.(sentBytes);

  // Normalde bu döngü her eksik parçayı gönderip son parçada complete:true
  // görür. Ama sunucu tüm parçaları almış olup birleştirmeyi başarısız
  // bitirmişse (ör. disk doluydu) receivedIndexes zaten totalChunks kadar
  // olur ve gönderilecek hiçbir eksik parça kalmaz - bu durumda son parçayı
  // idempotent olarak yeniden göndermek (bkz. sunucudaki "aynı parçanın
  // tekrar gönderimi" davranışı) birleştirmenin yeniden denenmesini sağlar.
  let indexesToSend = Array.from({ length: totalChunks }, (_, i) => i).filter((i) => !receivedIndexes.has(i));
  if (indexesToSend.length === 0 && receivedIndexes.size === totalChunks) {
    indexesToSend = [totalChunks - 1];
    const { start, end } = chunkByteRange(totalChunks - 1, size);
    sentBytes -= end - start;
  }

  let complete = false;
  for (const i of indexesToSend) {
    const { start, end } = chunkByteRange(i, size);
    const blob = source.slice(start, end);
    const result = await uploadChunkXhr({
      baseUrl,
      deviceId,
      token,
      uploadId,
      fileName: file.name,
      targetPath,
      note: i === 0 ? note : null,
      chunkIndex: i,
      totalChunks,
      blob,
      // Oranı parçanın ham boyutuyla ölçekle: chunkSent artık bayt
      // değil, o isteğin tamamlanma oranı.
      onProgress: (fraction) => onProgress?.(sentBytes + (end - start) * fraction),
    });
    sentBytes += end - start;
    onProgress?.(sentBytes);
    complete = result.complete;
    if (complete) break;
  }

  // Sunucu tüm parçaları almış olabilir ama birleştirmeyi tamamlayamamış
  // olabilir (disk doldu, hedef yazılamadı vb.). Bu durumda complete hiç
  // true dönmez. Eskiden bu hiç kontrol edilmiyordu: fonksiyon normal
  // dönüyor, arayüz "Yükleme tamamlandı" diyor ve devam ettirme kaydı da
  // siliniyordu - dosya ne sunucuda tam, ne yeniden denenebilir kalıyordu.
  // Kaydı BİLEREK silmiyoruz ki kullanıcı tekrar denediğinde alınmış
  // parçalar atlanabilsin.
  if (!complete) {
    throw new ApiRequestError(500, 'Sunucu yüklemeyi tamamlayamadı, tekrar dene');
  }

  await clearPendingUploadId(sessionKey);
}

/**
 * Seçilen dosyaları (ve varsa notu) sunucuya yükler. CHUNK_UPLOAD_THRESHOLD_BYTES
 * altındaki dosyalar tek istekte (uploadSmallFiles), üstündekiler otomatik
 * olarak parça parça (uploadFileInChunks) gider - çağıran taraf için tek bir
 * fonksiyon, iki dosya da aynı anda seçilse bile karışık gönderilebilir.
 * targetPath verilmezse depo kökü ('/') hedeflenir.
 */
export async function uploadFiles(
  files: UploadFileInput[],
  note: string,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  targetPath: string = '/'
): Promise<void> {
  const sized = files.map((f) => {
    const source = new File(f.uri);
    return { file: f, size: source.exists ? source.size : 0 };
  });

  const smallFiles = sized.filter((f) => f.size < CHUNK_UPLOAD_THRESHOLD_BYTES);
  const largeFiles = sized.filter((f) => f.size >= CHUNK_UPLOAD_THRESHOLD_BYTES);

  const totalBytes = sized.reduce((sum, f) => sum + f.size, 0) || 1;
  let completedBytes = 0;

  // Notun tek bir taşıyıcısı olmalı: küçük parti varsa not ONUNLA gider,
  // yoksa ilk büyük dosyayla. Eskiden burada `largeFiles.length === 0 ? note : ''`
  // yazıyordu; küçük VE büyük dosya birlikte seçildiğinde küçük parti notu
  // boşaltıyor, büyük dosya dalı da `smallFiles.length === 0` koşuluna
  // takıldığı için null geçiyordu - not hiçbir isteğe binmiyor, kullanıcı
  // "Yüklendi" görüyordu.
  if (smallFiles.length > 0 || (largeFiles.length === 0 && note.trim().length > 0)) {
    const noteForSmallBatch = note;
    // Partinin ham bayt payı: isteğin tamamlanma oranı bununla ölçekleniyor.
    // Eskiden xhr'ın ham `loaded` değeri doğrudan bildiriliyordu; o değer
    // multipart ek yükünü de içerdiğinden yüzde %100'ü aşıyordu.
    const smallRawTotal = smallFiles.reduce((sum, f) => sum + f.size, 0);
    await uploadSmallFiles(
      smallFiles.map((f) => f.file),
      noteForSmallBatch,
      targetPath,
      (fraction) => onProgress?.(completedBytes + smallRawTotal * fraction, totalBytes)
    );
    completedBytes += smallRawTotal;
    onProgress?.(completedBytes, totalBytes);
  }

  for (let i = 0; i < largeFiles.length; i++) {
    const { file, size } = largeFiles[i];
    const noteForThisFile = i === 0 && smallFiles.length === 0 ? note : null;
    const base = completedBytes;
    await uploadFileInChunks(file, noteForThisFile, targetPath, (sent) => onProgress?.(base + sent, totalBytes));
    completedBytes += size;
    onProgress?.(completedBytes, totalBytes);
  }
}

/**
 * Bir dosyayı indirir. Range header desteği ve devam ettirilebilirlik
 * expo-file-system'in legacy resumable API'si üzerinden sağlanır.
 */
export async function downloadFile(
  fileId: string,
  fileName: string,
  onProgress?: (writtenBytes: number, totalBytes: number) => void
): Promise<string> {
  const dir = `${FileSystem.documentDirectory}indirilenler/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const dest = dir + fileName;

  const downloadUrl = await getDownloadUrl(fileId);
  const { deviceId, token } = await resolveCredentials();

  await startDownloadNotification(fileName);

  const resumable = FileSystem.createDownloadResumable(
    downloadUrl,
    dest,
    { headers: { 'X-Device-Id': deviceId, Authorization: `Bearer ${token}` } },
    (data) => {
      onProgress?.(data.totalBytesWritten, data.totalBytesExpectedToWrite);
      updateDownloadProgress(fileName, data.totalBytesWritten, data.totalBytesExpectedToWrite);
    }
  );

  let result: Awaited<ReturnType<typeof resumable.downloadAsync>>;
  try {
    result = await resumable.downloadAsync();
  } catch {
    await stopDownloadNotification({ success: false, fileName });
    throw new ApiUnreachableError();
  }

  if (!result) {
    await stopDownloadNotification({ success: false, fileName });
    throw new ApiUnreachableError();
  }
  if (result.status === 401) {
    await stopDownloadNotification({ success: false, fileName });
    await handleUnauthorized();
    throw new Unauthorized401Error();
  }
  if (result.status < 200 || result.status >= 300) {
    await stopDownloadNotification({ success: false, fileName });
    throw new ApiRequestError(result.status, `İndirme başarısız: ${result.status}`);
  }

  // Paylaşılan depolamaya kopyalandıktan (ya da kopyalama kesin olarak
  // başarısız olduktan) sonra uygulamanın özel alanındaki geçici kopya
  // SİLİNMELİ. Eskiden hiç silinmiyordu: her indirilen dosya telefonda iki
  // kopya hâlinde kalıyor ve uygulamanın özel alanı sınırsız büyüyordu -
  // kullanıcının bu alanı temizlemesinin tek yolu "uygulama verilerini sil"
  // idi, o da eşleştirmeyi ve klasör seçimini de siliyordu.
  let target: SaveTarget;
  try {
    target = await saveToSharedStorage(result.uri, fileName, result.mimeType ?? null);
  } catch (e) {
    await deleteTempCopy(result.uri);
    await stopDownloadNotification({ success: false, fileName });
    throw e;
  }
  await deleteTempCopy(result.uri);

  // Bildirimler ekranı "dosyayı aç" diyebilsin diye nereye kaydettiğimizi
  // hatırlıyoruz: sunucudan gelen aktarım kaydı yalnızca SUNUCUDAKİ yolu
  // biliyor, telefondaki kopyanın content:// URI'si sadece burada elimizde.
  if (target.kind === 'folder') {
    await rememberSavedFile(fileName, { kind: 'folder', uri: target.uri, mimeType: target.mimeType, at: Date.now() });
  } else if (target.kind === 'gallery') {
    await rememberSavedFile(fileName, { kind: 'gallery', at: Date.now() });
  }

  await stopDownloadNotification({ success: true, fileName });
  return target.kind === 'folder' ? target.uri : '';
}

/** Geçici kopyayı siler; silme başarısız olursa indirmeyi başarısız SAYMAZ. */
async function deleteTempCopy(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (e) {
    console.warn('[api] Geçici indirme kopyası silinemedi', e);
  }
}
