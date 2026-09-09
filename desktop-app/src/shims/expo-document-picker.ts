/**
 * expo-document-picker'ın masaüstü karşılığı — Electron'un native
 * dialog.showOpenDialog'u (main process, bkz. electron/main/client.ts
 * pickFiles) üzerinden çalışır. aktarim.tsx'teki
 * `DocumentPicker.getDocumentAsync({multiple, copyToCacheDirectory})`
 * çağrısı değişmeden çalışsın diye aynı `{canceled, assets}` şeklini
 * taklit ediyor - copyToCacheDirectory'nin masaüstünde bir karşılığı yok
 * (zaten gerçek dosya yolunu kullanıyoruz, ayrıca bir önbelleğe kopyalamaya
 * gerek yok), sessizce yok sayılıyor.
 */
export type DocumentPickerAsset = { uri: string; name: string; size?: number; mimeType?: string };
export type DocumentPickerResult = { canceled: true; assets?: undefined } | { canceled: false; assets: DocumentPickerAsset[] };

export async function getDocumentAsync(_options?: {
  multiple?: boolean;
  copyToCacheDirectory?: boolean;
}): Promise<DocumentPickerResult> {
  const picked = await window.desktop.client.pickFiles();
  if (picked.length === 0) return { canceled: true };
  return {
    canceled: false,
    assets: picked.map((f) => ({ uri: f.path, name: f.name, size: f.size })),
  };
}
