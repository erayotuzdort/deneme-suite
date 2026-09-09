import { dialog, BrowserWindow } from 'electron';
import { createWriteStream, openAsBlob } from 'node:fs';
import { stat, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { settings } from './settings';
import { getStoredCredentials } from './credentials';
import { addTransfer } from './transfers';
import { broadcastToWindows } from './broadcast';

/**
 * mobildeki services/api.ts'in İSTEMCİ ROLÜ (Bildirimler/Dosyalar/Aktarım
 * sekmeleri) için masaüstü karşılığı — ama burada, main process'te. Renderer
 * doğrudan fetch() ATAMAZ (deneme-server CORS header'ı göndermiyor, Electron
 * renderer'ı da normal bir tarayıcı gibi CORS uyguluyor); bu yüzden TÜM ağ
 * istekleri main process'ten (Node'da CORS kısıtı yok) yapılıp IPC üzerinden
 * renderer'a JSON olarak dönüyor. Bu, ping/getDevices/getFiles/removeDevice
 * gibi tüm uçlar için TEK, tutarlı bir çözüm.
 */

const REQUEST_TIMEOUT_MS = 8000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2500;
/** Tek istekte giden küçük dosya partisi diskten akışla okunuyor - cömert. */
const UPLOAD_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** İndirme ilerlemesi IPC yayını için en kısa aralık (bkz. downloadFile). */
const PROGRESS_BROADCAST_INTERVAL_MS = 100;

/** Manuel bir adres girilmemişse bu bilgisayarın kendi gömülü sunucusuna
 * (http://localhost:<port>) varsayılan olarak bağlanır - Aktarım/Dosyalar/
 * Bildirimler'in kendi localhost sunucusunu otomatik tanıması için (bkz.
 * src/services/apiConfig.ts - AYNI varsayılan orada da uygulanıyor ama SADECE
 * "Sunucu Adresi" modalının gösterdiği değer için; gerçek istekler BURADAN
 * atıldığından asıl düzeltme burası). Böylece "not-configured" artık normal
 * yerel kullanımda hiç tetiklenmiyor - sunucu gerçekten kapalıysa/erişilemez
 * durumdaysa fetch kendisi başarısız olup doğru şekilde "unreachable" döner. */
function resolveServerAddress(): string {
  const manual = settings.get('serverAddress');
  if (manual) return manual;
  return `http://localhost:${settings.get('port')}`;
}

function authHeaders(): Record<string, string> {
  const creds = getStoredCredentials();
  if (!creds) return {};
  return { 'X-Device-Id': creds.deviceId, Authorization: `Bearer ${creds.token}` };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type ClientResult = { status: number; body: unknown };

/**
 * Genel amaçlı istek: ping/getDevices/getFiles/removeDevice hepsi bunun
 * üstünden geçiyor. status:0, mobildeki ApiUnreachableError/ApiNotConfiguredError/
 * NotPairedError karşılığı özel durumları taşımak için ("not-configured",
 * "not-paired", "unreachable") - renderer'daki api.ts bu üç değeri kendi
 * hata sınıflarına çeviriyor.
 */
export async function clientRequest(method: string, requestPath: string, body?: unknown): Promise<ClientResult> {
  const serverAddress = resolveServerAddress();
  const creds = getStoredCredentials();
  if (!creds) return { status: 0, body: { error: 'not-paired' } };

  const url = `${serverAddress}${requestPath}`;
  const headers: Record<string, string> = { ...authHeaders() };
  let requestBody: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  let lastErrorMessage: string | undefined;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // Yeniden denemeyi renderer'a DUYUR: mobilde bu bilgi onRetry
      // geri çağrısıyla taşınıyor ve "tekrar deneniyor…" bandını açıyor.
      // Masaüstünde bu sinyal hiç iletilmediği için kullanıcı ~25 saniye
      // boyunca hiçbir geri bildirim almadan bekliyordu.
      broadcastToWindows('client:retry', { attempt, maxAttempts: RETRY_ATTEMPTS });
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    try {
      const res = await fetchWithTimeout(url, { method, headers, body: requestBody }, REQUEST_TIMEOUT_MS);
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, body: json };
    } catch (e) {
      lastErrorMessage = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (attempt === RETRY_ATTEMPTS) {
        return { status: 0, body: { error: 'unreachable', url, cause: lastErrorMessage } };
      }
    }
  }
  return { status: 0, body: { error: 'unreachable', url, cause: lastErrorMessage } };
}

export async function pickFiles(): Promise<{ path: string; name: string; size: number }[]> {
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
  if (result.canceled) return [];

  const stats = await Promise.all(result.filePaths.map((p) => stat(p)));
  return result.filePaths.map((p, i) => ({ path: p, name: path.basename(p), size: stats[i].size }));
}

/** Bu boyutun üstündeki dosyalar tek istekte değil, parça parça yüklenir (mobildeki eşiğin aynısı). */
const CHUNK_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
/** Sunucudaki chunkUploadMiddleware limiti 3MB (parça + multipart ek yükü) - altında güvenli pay. */
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

function generateUploadId(): string {
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Yarıda kalan bir parçalı yüklemenin uploadId'si, sonraki denemede kaldığı
 * yerden devam edebilmek için diskte tutulur. Mobil taraf bunu AsyncStorage'da
 * saklıyor (bkz. mobile-app services/api.ts); masaüstünde hiçbir kalıcılık
 * yoktu, bu yüzden `resumeUploadId` parametresi yazılmış ama HİÇ
 * çağrılmıyordu - devam mantığının tamamı ölü koddu ve her kopma dosyayı
 * baştan gönderiyordu.
 *
 * Anahtar hedef+ad+boyut: aynı dosyanın farklı klasörlere gönderimi ayrı
 * oturumdur; boyut değişmişse dosya artık başka bir dosyadır ve eski
 * parçalar kullanılamaz.
 */
function pendingUploadKey(targetPath: string, fileName: string, size: number): string {
  return `${targetPath}|${fileName}|${size}`;
}

function readPendingUploadId(key: string): string | undefined {
  return settings.get('pendingUploads')?.[key];
}

function writePendingUploadId(key: string, uploadId: string): void {
  settings.set('pendingUploads', { ...(settings.get('pendingUploads') ?? {}), [key]: uploadId });
}

function clearPendingUploadId(key: string): void {
  const all = { ...(settings.get('pendingUploads') ?? {}) };
  if (!(key in all)) return;
  delete all[key];
  settings.set('pendingUploads', all);
}

/** Parça yüklemede geçici bir ağ hatası tüm dosyayı düşürmesin. */
const CHUNK_RETRY_ATTEMPTS = 3;
const CHUNK_RETRY_DELAY_MS = 1500;
/** Bir parça (≤2 MB) + multipart ek yükü için fazlasıyla geniş. */
const CHUNK_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Tek bir büyük dosyayı parçalara bölüp sırayla yükler; yarıda kalmış bir
 * oturum varsa sunucudaki GET /upload/status ile alınmış parçaları atlayıp
 * kalanından devam eder.
 *
 * Neden gerekliydi: mobil taraf 20MB üstünü zaten böyle gönderiyordu ama
 * masaüstü HER boyutu tek istekte yolluyordu - bağlantı koptuğunda 4 GB'lık
 * bir dosya baştan başlıyordu.
 */
async function uploadFileInChunks(
  file: { path: string; name: string },
  note: string | null,
  targetPath: string,
  serverAddress: string
): Promise<{ ok: boolean; error?: string }> {
  const size = (await stat(file.path)).size;
  const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE_BYTES));
  const key = pendingUploadKey(targetPath, file.name, size);

  const resumeUploadId = readPendingUploadId(key);
  let uploadId = resumeUploadId ?? generateUploadId();
  let received = new Set<number>();

  if (resumeUploadId) {
    try {
      const statusRes = await fetchWithTimeout(
        `${serverAddress}/api/files/upload/status?uploadId=${encodeURIComponent(uploadId)}`,
        { headers: authHeaders() },
        REQUEST_TIMEOUT_MS
      );
      if (statusRes.ok) {
        const body = (await statusRes.json()) as { fileName: string; totalChunks: number; receivedChunkIndexes: number[] };
        if (body.fileName === file.name && body.totalChunks === totalChunks) {
          received = new Set(body.receivedChunkIndexes);
        } else {
          uploadId = generateUploadId();
        }
      } else {
        // 404: oturum sunucuda yok (temizlenmiş ya da tamamlanmış) - baştan başla.
        uploadId = generateUploadId();
      }
    } catch {
      uploadId = generateUploadId();
    }
  }

  // Oturum kimliği İLK parçadan ÖNCE yazılmalı: ilk denemede kopan bir
  // yükleme de devam ettirilebilir olmalı.
  writePendingUploadId(key, uploadId);

  const handle = await open(file.path, 'r');
  try {
    for (let i = 0; i < totalChunks; i++) {
      if (received.has(i)) continue;
      const start = i * CHUNK_SIZE_BYTES;
      const end = Math.min(start + CHUNK_SIZE_BYTES, size);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, end - start, start);

      let lastError: unknown;
      let done = false;
      // Aynı chunkIndex'i tekrar göndermek sunucuda idempotent (üzerine
      // yazılıyor), bu yüzden yeniden deneme güvenli.
      for (let attempt = 1; attempt <= CHUNK_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          broadcastToWindows('client:retry', { attempt, maxAttempts: CHUNK_RETRY_ATTEMPTS });
          await new Promise((r) => setTimeout(r, CHUNK_RETRY_DELAY_MS));
        }
        const form = new FormData();
        form.append('uploadId', uploadId);
        form.append('fileName', file.name);
        form.append('targetPath', targetPath);
        if (i === 0 && note) form.append('note', note);
        form.append('chunkIndex', String(i));
        form.append('totalChunks', String(totalChunks));
        form.append('chunk', new Blob([buffer]), 'chunk.part');

        try {
          const res = await fetchWithTimeout(
            `${serverAddress}/api/files/upload/chunk`,
            { method: 'POST', headers: authHeaders(), body: form },
            CHUNK_REQUEST_TIMEOUT_MS
          );
          // 4xx/5xx anlamlı bir yanıttır - tekrar denemek aynı sonucu verir.
          if (res.status === 401) return { ok: false, error: 'unauthorized' };
          if (!res.ok) return { ok: false, error: `upload-failed-${res.status}` };
          const body = (await res.json()) as { complete?: boolean };
          if (body.complete) {
            clearPendingUploadId(key);
            return { ok: true };
          }
          done = true;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      // Ağ hatası kalıcı: oturum kimliği DİSKTE KALIYOR ki sonraki deneme
      // kaldığı yerden devam etsin.
      if (!done) throw lastError;
    }
  } finally {
    await handle.close();
  }
  clearPendingUploadId(key);
  return { ok: true };
}

export async function uploadFiles(
  files: { path: string; name: string; mimeType?: string }[],
  note: string,
  targetPath: string = '/'
): Promise<{ ok: boolean; error?: string }> {
  const serverAddress = resolveServerAddress();
  const creds = getStoredCredentials();
  if (!creds) return { ok: false, error: 'not-paired' };

  const trimmedNote = note.trim();

  // Büyük dosyalar parçalı yola ayrılıyor; küçükler eskisi gibi tek istekte.
  const sized = await Promise.all(
    files.map(async (f) => ({ file: f, size: (await stat(f.path)).size.valueOf() }))
  );
  const large = sized.filter((s) => s.size >= CHUNK_UPLOAD_THRESHOLD_BYTES);
  const small = sized.filter((s) => s.size < CHUNK_UPLOAD_THRESHOLD_BYTES);

  // NOTUN TEK BİR TAŞIYICISI OLMALI. Eskiden iki dal da notu eliyordu:
  // büyük dosya dalı `small.length === 0` istiyordu, küçük parti dalı
  // `large.length === 0` istiyordu - karışık bir partide (bir büyük + bir
  // küçük dosya) İKİSİ DE yanlış oluyor ve not hiçbir isteğe binmeden
  // sessizce kayboluyordu; kullanıcı yine de "Yüklendi" görüyordu.
  // Aynı hata mobil tarafta bulunup düzeltilmişti (bkz. mobile-app
  // services/api.ts'teki uploadFiles yorumu), düzeltme buraya taşınmamıştı.
  // Kural artık tek cümle: küçük parti gidiyorsa not ONUNLA gider, yoksa
  // ilk büyük dosyayla.
  const smallBatchRuns = small.length > 0 || (large.length === 0 && trimmedNote.length > 0);
  const noteRidesWithSmallBatch = smallBatchRuns && trimmedNote.length > 0;

  // Sıra mobil tarafla aynı: önce küçük parti, sonra büyükler. Böylece not
  // (varsa) ilk istekte gider ve kullanıcı mesajını hemen görür.
  if (smallBatchRuns) {
    const form = new FormData();
    for (const { file: f } of small) {
      // fs.openAsBlob: dosyayı belleğe tamamen yüklemeden, diskten akışla
      // (streaming) formData'ya ekler - büyük dosyalarda bellek güvenli.
      const blob = await openAsBlob(f.path, { type: f.mimeType || 'application/octet-stream' });
      form.append('files', blob, f.name);
    }
    form.append('targetPath', targetPath);
    if (noteRidesWithSmallBatch) form.append('note', trimmedNote);

    try {
      const res = await fetchWithTimeout(
        `${serverAddress}/api/files/upload`,
        { method: 'POST', headers: authHeaders(), body: form },
        UPLOAD_REQUEST_TIMEOUT_MS
      );
      if (res.status === 401) return { ok: false, error: 'unauthorized' };
      if (!res.ok) return { ok: false, error: `upload-failed-${res.status}` };
    } catch {
      // Yalnızca istek sunucuya HİÇ ulaşamadığında kaydediyoruz. Sunucuya
      // ulaşan istekler (2xx de, 4xx/5xx de) gömülü sunucunun kendi
      // config.onTransfer kancasından zaten geçiyor - burada da kaydetmek
      // aynı aktarımı listede iki kez gösterirdi.
      recordUnreachable('incoming', small.map((s) => s.file.name).join(', ') || '(not)');
      return { ok: false, error: 'unreachable' };
    }
  }

  for (const [index, item] of large.entries()) {
    try {
      const result = await uploadFileInChunks(
        item.file,
        index === 0 && !noteRidesWithSmallBatch && trimmedNote ? trimmedNote : null,
        targetPath,
        serverAddress
      );
      if (!result.ok) return result;
    } catch {
      recordUnreachable('incoming', item.file.name);
      return { ok: false, error: 'unreachable' };
    }
  }

  return { ok: true };
}

/** Sunucuya hiç ulaşamayan aktarımı geçmişe "başarısız" olarak yazar. */
function recordUnreachable(direction: 'incoming' | 'outgoing', fileName: string): void {
  addTransfer({
    direction,
    status: 'failed',
    fileName,
    path: null,
    sizeBytes: null,
    deviceId: null,
    deviceName: 'bu bilgisayar',
    error: 'Sunucuya ulaşılamadı',
  });
}

/**
 * Hedef adı ATOMİK olarak sahiplenir: dosyayı "wx" (exclusive create) ile
 * açar, hemen kapatır ve yolu döndürür. Artık dosya var olduğundan, aynı anda
 * çalışan başka bir indirme aynı adı denediğinde EEXIST alıp bir sonraki ada
 * geçer.
 *
 * Eskiden "önce access() ile var mı bak, sonra yaz" deseni vardı ve kontrol
 * ile yazma arasındaki pencerede iki indirme AYNI yolu seçebiliyordu: üç eş
 * zamanlı indirme ölçüldüğünde üçü de ok:true döndü ama diskte iki dosya
 * oluştu - biri diğerinin içeriğiyle sessizce üzerine yazıldı. Aynı süreçteki
 * deliver.ts bu yarışı COPYFILE_EXCL ile zaten doğru çözüyordu; burada da
 * aynı çekirdek düzeyi garantiyi kullanıyoruz.
 */
async function claimDestination(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let i = 0; i < 1000; i++) {
    const full = path.join(dir, i === 0 ? fileName : `${base} (${i})${ext}`);
    try {
      const handle = await open(full, 'wx');
      await handle.close();
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  // 1000 ad da doluysa: çakışmayacak bir ada düş (üzerine yazmaktansa).
  const fallback = path.join(dir, `${base}-${Date.now()}${ext}`);
  const handle = await open(fallback, 'w');
  await handle.close();
  return fallback;
}

export async function downloadFile(
  remotePath: string,
  fileName: string
): Promise<{ ok: boolean; savedPath?: string; error?: string }> {
  const serverAddress = resolveServerAddress();
  const creds = getStoredCredentials();
  if (!creds) return { ok: false, error: 'not-paired' };
  const downloadFolder = settings.get('downloadFolder');
  if (!downloadFolder) return { ok: false, error: 'no-download-folder' };

  const url = `${serverAddress}/api/files/download?path=${encodeURIComponent(remotePath)}`;
  let res: Response;
  try {
    // Zaman aşımı yalnızca BAŞLIKLARI kapsar: fetch, gövde inmeden çözülür ve
    // zamanlayıcı finally'de temizlenir, dolayısıyla uzun süren bir indirme
    // yarıda kesilmez. Öncesinde hiç zaman aşımı yoktu - cevap vermeyen bir
    // sunucuda IPC çağrısı süresiz asılı kalıyordu.
    res = await fetchWithTimeout(url, { headers: authHeaders() }, REQUEST_TIMEOUT_MS);
  } catch {
    recordUnreachable('outgoing', fileName);
    return { ok: false, error: 'unreachable' };
  }
  if (res.status === 401) return { ok: false, error: 'unauthorized' };
  if (!res.ok || !res.body) return { ok: false, error: `download-failed-${res.status}` };

  const totalBytes = Number(res.headers.get('content-length') ?? 0);
  const destPath = await claimDestination(downloadFolder, fileName);

  let writtenBytes = 0;
  let lastBroadcastAt = 0;
  const nodeReadable = Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>);
  nodeReadable.on('data', (chunk: Buffer) => {
    writtenBytes += chunk.length;
    // Kısıtlama olmadan her ~64 KB'lik parça için bir IPC mesajı gidiyordu -
    // hızlı bir yerel indirmede saniyede binlerce mesaj, renderer'ı boşuna
    // meşgul ediyordu. İnsan gözü için 10/sn fazlasıyla yeterli.
    const now = Date.now();
    if (now - lastBroadcastAt < PROGRESS_BROADCAST_INTERVAL_MS && writtenBytes < totalBytes) return;
    lastBroadcastAt = now;
    broadcastToWindows('client:download-progress', { fileName, writtenBytes, totalBytes });
  });

  try {
    await pipeline(nodeReadable, createWriteStream(destPath));
  } catch {
    // Sunucu bunu BAŞARILI bir gönderim sayar (baytlar karşıya gitti) -
    // diske yazamayan taraf biziz, bu hatayı yalnızca burası bilebilir.
    // Yarım kalan dosyayı bırakmıyoruz: claimDestination onu zaten
    // oluşturduğundan, silmezsek 0 baytlık/yarım bir dosya kalırdı.
    await rm(destPath, { force: true }).catch(() => {});
    recordUnreachable('outgoing', fileName);
    return { ok: false, error: 'download-write-failed' };
  }

  return { ok: true, savedPath: destPath };
}
