/**
 * mobildeki services/sharedStorage.ts (SAF/MediaLibrary) karşılığı -
 * masaüstünde SAF gibi bir kısıt yok, kullanıcı sadece bir indirme klasörü
 * seçiyor (native dialog.showOpenDialog, main process'te). explore.tsx
 * sadece bu iki fonksiyonu import ediyor (chooseDownloadFolder,
 * getCachedDownloadFolderName) - saveToSharedStorage'ın masaüstü karşılığı
 * indirme akışının kendisinde (services/api.ts -> electron/main/client.ts,
 * doğrudan fs.createWriteStream), ayrı bir fonksiyon olarak burada yok.
 */
function folderDisplayName(folderPath: string): string {
  const parts = folderPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : folderPath;
}

export async function getCachedDownloadFolderName(): Promise<string | null> {
  const folder = await window.desktop.client.getDownloadFolder();
  return folder ? folderDisplayName(folder) : null;
}

export async function chooseDownloadFolder(): Promise<string | null> {
  const folder = await window.desktop.client.pickDownloadFolder();
  return folder ? folderDisplayName(folder) : null;
}

/** mobildeki openSavedFile karşılığı. */
export type OpenResult = 'opened' | 'missing' | 'no-app' | 'failed';

/**
 * Masaüstünde Bildirimler ekranı ORTAK olan değil, src/screens/BildirimlerScreen.tsx —
 * bu fonksiyonu çağıran yok. Yalnızca ortak kodun iki platformda da tip
 * denetiminden geçmesi için tanımlı.
 */
export async function openSavedFile(_uri: string, _mimeType: string | null): Promise<OpenResult> {
  return 'failed';
}

/** mobildeki SaveTarget karşılığı — ortak kodun tip denetimi için. */
export type SaveTarget =
  | { kind: 'gallery' }
  | { kind: 'folder'; uri: string; mimeType: string }
  | { kind: 'unsupported' };
