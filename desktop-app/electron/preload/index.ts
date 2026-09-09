import { contextBridge, ipcRenderer } from 'electron';

export type DesktopSettingsInfo = { storageRoot: string | null; port: number; autoLaunch: boolean; autoStartServer: boolean };
export type ServerLifecycleState = 'stopped' | 'stopping' | 'starting' | 'running' | 'retrying' | 'failed';
export type ServerStatusInfo = {
  state: ServerLifecycleState;
  running: boolean;
  host?: string;
  port?: number;
  retryAttempt?: number;
  maxRetries?: number;
  lastError?: string;
};
export type PairResult = { deviceId: string; name: string; token: string; pairedAt: string };
export type DeviceSummary = { deviceId: string; name: string; pairedAt: string; lastSeenAt: string | null; connected: boolean };
export type MessageSummary = { id: string; fileName: string; note: string; uploadedBy: string | null; uploadedAt: string };
export type NetworkAddress = { url: string; ip: string; kind: 'tailscale' | 'lan'; interfaceName: string };
export type NetworkInfo = { hostName: string; addresses: NetworkAddress[] };
export type OpResult = { ok: boolean; error?: string };
export type ClientResult = { status: number; body: unknown };
export type CredentialsInfo = { deviceId: string; token: string } | null;
export type PickedFile = { path: string; name: string; size: number };
export type DownloadResult = { ok: boolean; savedPath?: string; error?: string };
export type DownloadProgress = { fileName: string; writtenBytes: number; totalBytes: number };
export type TransferRecord = {
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
  unread: boolean;
};

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

/**
 * Renderer'a açılan tek yüzey. contextIsolation açık, nodeIntegration kapalı
 * (Electron güvenlik varsayılanları korunuyor) - renderer'ın ham Node/Electron
 * API'lerine erişimi yok, sadece burada tanımlanan dar, tipli fonksiyonlara.
 */
const api = {
  settings: {
    get: () => invoke<DesktopSettingsInfo>('settings:get'),
    pickStorageFolder: () => invoke<string | null>('settings:pickStorageFolder'),
    setPort: (port: number) => invoke<OpResult>('settings:setPort', port),
    setAutoLaunch: (enabled: boolean) => invoke<void>('settings:setAutoLaunch', enabled),
    setAutoStartServer: (enabled: boolean) => invoke<void>('settings:setAutoStartServer', enabled),
  },
  server: {
    start: () => invoke<OpResult>('server:start'),
    stop: () => invoke<void>('server:stop'),
    restart: () => invoke<OpResult>('server:restart'),
    status: () => invoke<ServerStatusInfo>('server:status'),
    pairDevice: (name: string) => invoke<PairResult>('server:pairDevice', name),
    listDevices: () => invoke<DeviceSummary[]>('server:listDevices'),
    removeDevice: (deviceId: string) => invoke<OpResult>('server:removeDevice', deviceId),
    listMessages: () => invoke<MessageSummary[]>('server:listMessages'),
    /** Bu bilgisayarın telefondan erişilebilir adresleri (Tailscale önce). */
    networkInfo: () => invoke<NetworkInfo>('server:networkInfo'),
    removeMessage: (id: string) => invoke<OpResult>('server:removeMessage', id),
    onStatusChange: (cb: (status: ServerStatusInfo) => void): (() => void) => {
      const listener = (_event: unknown, status: ServerStatusInfo) => cb(status);
      ipcRenderer.on('server:status-changed', listener);
      return () => {
        ipcRenderer.removeListener('server:status-changed', listener);
      };
    },
  },
  client: {
    getServerAddress: () => invoke<string | null>('client:getServerAddress'),
    setServerAddress: (url: string | null) => invoke<OpResult>('client:setServerAddress', url),
    getCredentials: () => invoke<CredentialsInfo>('client:getCredentials'),
    setCredentials: (deviceId: string, token: string) => invoke<OpResult>('client:setCredentials', deviceId, token),
    /** Geçersiz hâle gelmiş kimlik bilgisini siler - 401 kurtarma akışı için. */
    clearCredentials: () => invoke<OpResult>('client:clearCredentials'),
    request: (method: string, path: string, body?: unknown) =>
      invoke<ClientResult>('client:request', method, path, body),
    pickFiles: () => invoke<PickedFile[]>('client:pickFiles'),
    uploadFiles: (files: { path: string; name: string; mimeType?: string }[], note: string, targetPath?: string) =>
      invoke<OpResult>('client:uploadFiles', files, note, targetPath),
    downloadFile: (path: string, fileName: string) => invoke<DownloadResult>('client:downloadFile', path, fileName),
    getDownloadFolder: () => invoke<string | null>('client:getDownloadFolder'),
    pickDownloadFolder: () => invoke<string | null>('client:pickDownloadFolder'),
    pairWithOwnServer: () => invoke<OpResult>('client:pairWithOwnServer'),
    /** Main process bir isteği yeniden denediğinde tetiklenir — "tekrar deneniyor…" bandı için. */
    onRetry: (cb: (info: { attempt: number; maxAttempts: number }) => void): (() => void) => {
      const listener = (_event: unknown, info: { attempt: number; maxAttempts: number }) => cb(info);
      ipcRenderer.on('client:retry', listener);
      return () => {
        ipcRenderer.removeListener('client:retry', listener);
      };
    },
    onDownloadProgress: (cb: (info: DownloadProgress) => void): (() => void) => {
      const listener = (_event: unknown, info: DownloadProgress) => cb(info);
      ipcRenderer.on('client:download-progress', listener);
      return () => {
        ipcRenderer.removeListener('client:download-progress', listener);
      };
    },
  },
  transfers: {
    list: () => invoke<TransferRecord[]>('transfers:list'),
    remove: (ids: string[]) => invoke<void>('transfers:remove', ids),
    clear: () => invoke<void>('transfers:clear'),
    markRead: (ids: string[]) => invoke<void>('transfers:markRead', ids),
    /** Kayda ait dosyayı varsayılan uygulamada açar (yalnızca tek dosyalı kayıtlar). */
    openTarget: (id: string) => invoke<OpResult & { revealedInstead?: boolean }>('transfers:openTarget', id),
    /** Kayda ait dosyayı Gezgin'de seçili gösterir. */
    revealTarget: (id: string) => invoke<OpResult>('transfers:revealTarget', id),
    onChange: (cb: () => void): (() => void) => {
      const listener = () => cb();
      ipcRenderer.on('transfers:changed', listener);
      return () => {
        ipcRenderer.removeListener('transfers:changed', listener);
      };
    },
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
