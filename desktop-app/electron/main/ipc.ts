import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { ipcMain, dialog, app, shell, BrowserWindow, type OpenDialogOptions } from 'electron';
import * as ConfigModule from 'deneme-server/config';
import { settings, isValidPort, normalizeServerAddress } from './settings';
import { getNetworkInfo } from './network';
import { getStoredCredentials, setStoredCredentials, clearStoredCredentials } from './credentials';
import {
  startServer,
  stopServer,
  restartServer,
  serverStatus,
  pairNewDevice,
  listPairedDevices,
  removePairedDevice,
  listAllMessages,
  removeMessage,
} from './server';
import { clientRequest, pickFiles, uploadFiles, downloadFile } from './client';
import { listTransfers, removeTransfers, clearTransfers, markTransfersRead } from './transfers';

async function pickFolder(defaultPath?: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow();
  const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], defaultPath };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/**
 * Renderer'dan gelen kimlik dizisi. transfers:remove/markRead eskiden gelen
 * değeri doğrudan `new Set(ids)` içine veriyordu; sayı ya da nesne
 * gönderildiğinde "is not iterable" ile IPC çağrısı reddediliyordu.
 */
function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** devices.json'a sınırsız uzunlukta ad yazılmasını engeller. */
const MAX_DEVICE_NAME_LENGTH = 120;

/**
 * Bir aktarım kaydının işaret ettiği açılabilir dosya yolunu çözer.
 *
 * "Açılabilir" kuralı BURADA, tek yerde tanımlı: kayıt başarılı olmalı ve tek
 * bir dosyaya işaret etmeli. Arayüz de aynı kuralı uyguluyor (bkz.
 * BildirimlerScreen.canOpen); kural iki yerde ayrı ayrı yazıldığında ikisi
 * ayrışıyordu - arayüz başarısız bir kayıt için "aç" sunmuyordu ama IPC ucu
 * doğrudan çağrıldığında dosyayı yine de açıyordu.
 *
 * Güvenlik: yol renderer'dan GELMİYOR; yalnızca kayıt kimliği geliyor ve yol
 * ana süreçteki kendi kaydımızdan okunuyor - bu uç "keyfi dosya aç" değil.
 */
async function resolveRecordTarget(
  id: unknown
): Promise<{ ok: true; target: string } | { ok: false; error: string }> {
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'Geçersiz kayıt' };
  const record = listTransfers().find((r) => r.id === id);
  if (!record) return { ok: false, error: 'Kayıt bulunamadı' };
  if (record.status !== 'success') return { ok: false, error: 'Bu aktarım tamamlanmadı, açılacak bir dosya yok' };

  const storageRoot = ConfigModule.config.storageRoot || settings.get('storageRoot');
  const target =
    record.savedPath ??
    (record.path && storageRoot ? path.join(storageRoot, record.path.replace(/^[/\\]+/, '')) : null);
  if (!target) return { ok: false, error: 'Bu kayıt tek bir dosyaya ait değil' };

  try {
    const stats = await stat(target);
    if (!stats.isFile()) return { ok: false, error: 'Hedef bir dosya değil' };
  } catch {
    return { ok: false, error: 'Dosya bulunamadı — taşınmış veya silinmiş olabilir' };
  }
  return { ok: true, target };
}

export function registerIpcHandlers(): void {
  // --- Sunucu ayarları (depo klasörü, port, açılışta başlatma) ---
  ipcMain.handle('settings:get', () => ({
    storageRoot: settings.get('storageRoot'),
    port: settings.get('port'),
    autoLaunch: settings.get('autoLaunch'),
    autoStartServer: settings.get('autoStartServer'),
  }));

  ipcMain.handle('settings:pickStorageFolder', async () => {
    const folder = await pickFolder(settings.get('storageRoot') ?? undefined);
    if (!folder) return null;
    const previous = settings.get('storageRoot');
    settings.set('storageRoot', folder);
    // config.storageRoot YALNIZCA sunucu açılışında okunuyor. Yeniden
    // başlatılmazsa sunucu eski klasöre yazmaya devam eder, arayüz ise
    // yeni klasörü gösterirdi - sessiz ve fark edilmesi çok zor bir
    // tutarsızlık. Port için "önce sunucuyu durdur" uyarısı vardı, klasör
    // için hiçbir şey yoktu; artık gerekiyorsa kendisi yeniden başlıyor.
    if (previous !== folder && serverStatus().running) {
      await restartServer();
    }
    return folder;
  });

  // Doğrulama ŞART: eskiden gelen değer (null, "abc", -1, 999999) doğrudan
  // diske yazılıyordu. null yazıldığında sunucu listen(null) ile RASTGELE bir
  // porta bağlanıp "Çalışıyor: 0.0.0.0:null" gösteriyor, telefon bir daha
  // bağlanamıyordu ve kullanıcı config.json'ı elle düzeltmeden kurtulamıyordu.
  ipcMain.handle('settings:setPort', (_event, port: unknown) => {
    if (!isValidPort(port)) return { ok: false, error: 'Geçersiz port (1-65535 arası bir sayı olmalı)' };
    settings.set('port', port);
    return { ok: true };
  });

  ipcMain.handle('settings:setAutoLaunch', (_event, enabled: boolean) => {
    settings.set('autoLaunch', enabled);
    app.setLoginItemSettings({ openAtLogin: enabled });
  });

  ipcMain.handle('settings:setAutoStartServer', (_event, enabled: boolean) => {
    settings.set('autoStartServer', enabled);
  });

  // --- Sunucu yaşam döngüsü + cihaz yönetimi (doğrudan çağrı, HTTP yok) ---
  ipcMain.handle('server:start', () => startServer());
  ipcMain.handle('server:stop', () => stopServer());
  ipcMain.handle('server:restart', () => restartServer());
  ipcMain.handle('server:status', () => serverStatus());
  ipcMain.handle('server:pairDevice', (_event, name: unknown) => {
    // pairNewDevice(name.trim()) ham girdiyle çağrılınca null/sayı için
    // TypeError ile IPC reddi oluyordu; artık anlamlı bir sonuç dönüyor.
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Cihaz adı gerekli');
    }
    if (name.length > MAX_DEVICE_NAME_LENGTH) {
      throw new Error(`Cihaz adı en fazla ${MAX_DEVICE_NAME_LENGTH} karakter olabilir`);
    }
    return pairNewDevice(name);
  });
  ipcMain.handle('server:listDevices', () => listPairedDevices());
  ipcMain.handle('server:removeDevice', (_event, deviceId: string) => removePairedDevice(deviceId));
  ipcMain.handle('server:listMessages', () => listAllMessages());
  // Telefona yazılacak adres. Port ayarlardan okunuyor ki sunucu kapalıyken
  // de doğru adresi gösterebilelim.
  ipcMain.handle('server:networkInfo', () => getNetworkInfo(settings.get('port')));
  ipcMain.handle('server:removeMessage', (_event, id: string) => removeMessage(id));

  // --- İstemci rolü (Bildirimler/Dosyalar/Aktarım - herhangi bir sunucuya bağlanır) ---
  ipcMain.handle('client:getServerAddress', () => settings.get('serverAddress'));
  ipcMain.handle('client:setServerAddress', (_event, url: unknown) => {
    // Nesne yazılabildiğinde tüm istemci istekleri kalıcı olarak bozuluyordu
    // ("[object Object]/ping") ve arayüzde geri döndürecek bir kontrol yoktu.
    const normalized = normalizeServerAddress(url);
    if (!normalized.ok) return { ok: false, error: 'Geçersiz adres (http:// veya https:// ile başlamalı)' };
    settings.set('serverAddress', normalized.value);
    return { ok: true };
  });
  ipcMain.handle('client:getCredentials', () => getStoredCredentials());
  ipcMain.handle('client:setCredentials', (_event, deviceId: unknown, token: unknown) => {
    if (typeof deviceId !== 'string' || typeof token !== 'string' || !deviceId || !token) {
      return { ok: false, error: 'Geçersiz kimlik bilgisi' };
    }
    try {
      setStoredCredentials(deviceId, token);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Kaydedilemedi' };
    }
  });
  /**
   * Kimlik bilgisi sunucuda artık geçerli değilse (cihaz çıkarılmış,
   * tokens.json sıfırlanmış) renderer bunu çağırıp kaydı siliyor. Öncesinde
   * clearStoredCredentials hiçbir yerden çağrılmıyordu: kimlik bilgisi
   * DURUYOR ama GEÇERSİZ olduğu için Dosyalar/Aktarım sonsuza kadar 401
   * veriyor, "bu bilgisayarı eşleştir" kartı da (kimlik bilgisi var diye)
   * gizli kalıyordu - arayüzden çıkışı olmayan bir çıkmaz.
   */
  ipcMain.handle('client:clearCredentials', () => {
    clearStoredCredentials();
    return { ok: true };
  });
  ipcMain.handle('client:request', (_event, method: string, path: string, body?: unknown) =>
    clientRequest(method, path, body)
  );
  ipcMain.handle('client:pickFiles', () => pickFiles());
  ipcMain.handle('client:uploadFiles', (_event, files: unknown, note: unknown, targetPath?: unknown) => {
    if (!Array.isArray(files)) return { ok: false, error: 'Geçersiz dosya listesi' };
    const valid = files.filter(
      (f): f is { path: string; name: string; mimeType?: string } =>
        typeof f === 'object' && f !== null && typeof (f as { path?: unknown }).path === 'string' &&
        typeof (f as { name?: unknown }).name === 'string'
    );
    if (valid.length !== files.length) return { ok: false, error: 'Geçersiz dosya girdisi' };
    return uploadFiles(valid, typeof note === 'string' ? note : '', typeof targetPath === 'string' ? targetPath : '/');
  });
  ipcMain.handle('client:downloadFile', (_event, remotePath: unknown, fileName: unknown) => {
    if (typeof remotePath !== 'string' || typeof fileName !== 'string' || !fileName) {
      return { ok: false, error: 'Geçersiz indirme isteği' };
    }
    return downloadFile(remotePath, fileName);
  });
  ipcMain.handle('client:getDownloadFolder', () => settings.get('downloadFolder'));
  ipcMain.handle('client:pickDownloadFolder', async () => {
    const folder = await pickFolder(settings.get('downloadFolder') ?? app.getPath('downloads'));
    if (folder) settings.set('downloadFolder', folder);
    return folder;
  });

  /**
   * Bu bilgisayarı KENDİ gömülü sunucusuna eşleştirir. Öncesinde masaüstünün
   * istemci rolü (Dosyalar/Aktarım/Bildirimler sekmeleri) eşleştirilmemiş
   * kalıyordu; kullanıcının Sunucu sekmesinde eşleştirme üretip çıkan JSON'u
   * aynı uygulamaya elle yapıştırması gerekiyordu.
   */
  ipcMain.handle('client:pairWithOwnServer', async () => {
    try {
      const result = await pairNewDevice(`${os.hostname()} (bu bilgisayar)`);
      setStoredCredentials(result.deviceId, result.token);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Eşleştirme başarısız oldu' };
    }
  });

  // --- Bildirimler (aktarım geçmişi) ---
  ipcMain.handle('transfers:list', () => listTransfers());
  ipcMain.handle('transfers:remove', (_event, ids: unknown) => removeTransfers(toIdList(ids)));
  ipcMain.handle('transfers:clear', () => clearTransfers());
  ipcMain.handle('transfers:markRead', (_event, ids: unknown) => markTransfersRead(toIdList(ids)));

  /**
   * Bir bildirime tıklandığında ilgili dosyayı açar.
   *
   * Hedef seçimi: önce `savedPath` (kullanıcının indirme klasöründeki kopya —
   * onun beklediği yer), yoksa depo klasöründeki asıl dosya. Yalnızca TEK bir
   * dosyaya ait kayıtlar açılabilir; birden çok dosyayı tek satırda toplayan
   * başarısızlık kayıtlarında yol zaten null olduğundan burada eleniyor.
   *
   * Güvenlik: açılacak yol renderer'dan GELMİYOR - yalnızca kayıt kimliği
   * geliyor ve yol ana süreçteki kendi kaydımızdan okunuyor. Böylece bu uç
   * "keyfi dosya aç" hâline gelmiyor.
   */
  ipcMain.handle('transfers:openTarget', async (_event, id: unknown) => {
    const resolved = await resolveRecordTarget(id);
    if (!resolved.ok) return resolved;
    const target = resolved.target;

    // openPath hata durumunda FIRLATMAZ, boş olmayan bir mesaj döner
    // (ör. dosya türü için kayıtlı uygulama yok).
    const failure = await shell.openPath(target);
    if (failure) {
      // Açılamıyorsa en azından Gezgin'de göster - kullanıcı elle açabilir.
      shell.showItemInFolder(target);
      return { ok: true, revealedInstead: true };
    }
    return { ok: true };
  });

  /** Dosyayı açmak yerine Gezgin'de klasörünü açıp seçili getirir. */
  ipcMain.handle('transfers:revealTarget', async (_event, id: unknown) => {
    const resolved = await resolveRecordTarget(id);
    if (!resolved.ok) return resolved;
    shell.showItemInFolder(resolved.target);
    return { ok: true };
  });
}
