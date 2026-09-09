import AsyncStorage from '@react-native-async-storage/async-storage';
import * as IntentLauncher from 'expo-intent-launcher';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

const { StorageAccessFramework } = FileSystem;

// Android'de expo-file-system'in indirdiği dosya, uygulamanın kendi özel
// (sandbox) alanında kalır — telefonun Dosyalar/İndirilenler uygulamasından
// görünmez. Bunu çözmek için: resim/video için expo-media-library (genel
// medya kütüphanesine kaydeder), diğer her dosya tipi için Storage Access
// Framework (kullanıcının seçtiği bir dizine kopyalar) kullanılıyor — ikisi
// de Android'e özel, iOS/web'de bu modülün tüm fonksiyonları no-op'tur.
const SAF_DIRECTORY_URI_KEY = 'safDownloadsDirectoryUri';

/** Kullanıcı gerekli izni (medya kütüphanesi) reddetti. */
export class SharedStoragePermissionDeniedError extends Error {
  constructor(message = 'Depolama izni verilmedi') {
    super(message);
    this.name = 'SharedStoragePermissionDeniedError';
  }
}

/**
 * İndirme klasörü hiç seçilmemiş, ya da önbellekteki seçim artık geçersiz
 * (klasör silinmiş/taşınmış, yazma izni elle iptal edilmiş vb.) — indirme
 * akışı artık kendiliğinden picker açmıyor, kullanıcı Aktarım sekmesinden
 * elle seçmeli.
 */
export class DownloadFolderNotSetError extends Error {
  constructor(message = 'Önce Aktarım sekmesinden indirme klasörü seç') {
    super(message);
    this.name = 'DownloadFolderNotSetError';
  }
}

function isImageOrVideoMimeType(mimeType: string | null): boolean {
  return !!mimeType && (mimeType.startsWith('image/') || mimeType.startsWith('video/'));
}

// Sunucudan indirme yanıtıyla gelen mimeType (expo-file-system'in
// createDownloadResumable sonucundaki result.mimeType) güvenilir değil —
// çoğu zaman genel application/octet-stream'e düşüyor. SAF'ta
// DocumentFile.createFile(mimeType, fileName) çağrısı (kurulu paketin
// native kaynağında doğrulandı: FileSystemLegacyModule.kt,
// "createSAFFileAsync" — `dir.createFile(mimeType, fileName)`), doğru
// uzantıyı SADECE mimeType'tan türetiyor (fileName uzantısız verilir, bkz.
// StorageAccessFramework.createFileAsync dokümantasyonu). mimeType generic
// kaldığında Android'in sağlayıcısı hangi uzantıyı ekleyeceğini bilemiyor
// ve dosya uzantısız kalıyor. Bu yüzden mimeType'ı sunucunun cevabından
// değil, orijinal dosya adının uzantısından türetiyoruz — deneme-server'ın
// src/files.ts'teki (doğrulanmış, üretimde kullanılan) MIME_TYPES
// tablosuyla birebir aynı, aralarında tutarlılık için.
const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

function getMimeTypeFromFileName(fileName: string): string | null {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_MIME_TYPES[ext] ?? null;
}

// İki hata imzası, önbellekteki directoryUri'nin artık geçersiz olduğunu
// gösteriyor:
// - "Destination '.../tree/primary:X/document/primary:X' directory cannot
//   be created" — GÜNCELLEME: bu hatanın asıl kaynağı önbellekteki klasör
//   DEĞİLMİŞ, StorageAccessFramework.copyAsync() çağrısının kendisiymiş
//   (bkz. copyIntoSafDirectory'deki açıklama — artık copyAsync
//   kullanılmıyor). Yine de gerçekten bozuk/silinmiş bir klasör de teorik
//   olarak createFileAsync aşamasında benzer bir hata üretebileceğinden bu
//   kontrol savunma amaçlı korunuyor.
// - "... isn't writable" — klasör hâlâ var ama yazma izni artık geçerli
//   değil (ör. kullanıcı Android ayarlarından izni elle iptal etti) — bu
//   hâlâ gerçek/geçerli bir senaryo.
// İkisinde de tek doğru davranış aynı: önbelleği temizleyip kullanıcıyı
// Aktarım sekmesinden yeniden seçmeye yönlendirmek — otomatik olarak
// tekrar picker açmıyoruz (bu daha önce "her indirmede tekrar soruyor"
// hissine yol açıyordu).
function isInvalidDirectoryError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /directory cannot be created/i.test(message) || /isn't writable/i.test(message);
}

function getDirectoryDisplayName(directoryUri: string): string {
  const lastRawSegment = directoryUri.split('/').pop() ?? directoryUri;
  const decoded = decodeURIComponent(lastRawSegment);
  const withoutVolumePrefix = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
  const parts = withoutVolumePrefix.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : decoded;
}

/** Önbellekteki indirme klasörünü (varsa) kullanıcıya gösterilebilir adıyla döner — picker AÇMAZ. */
export async function getCachedDownloadFolderName(): Promise<string | null> {
  const cached = await AsyncStorage.getItem(SAF_DIRECTORY_URI_KEY);
  return cached ? getDirectoryDisplayName(cached) : null;
}

/**
 * Kullanıcı Aktarım sekmesinde "Klasör Seç"/"Değiştir" butonuna bastığında
 * çağrılır — SAF picker'ı açar, seçilen klasörü önbelleğe kaydeder. Kullanıcı
 * seçimi iptal ederse (ya da izin vermezse) null döner, hata fırlatmaz —
 * DocumentPicker'ın iptal durumuyla aynı sessiz no-op deseni.
 */
export async function chooseDownloadFolder(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!result.granted) return null;

  await AsyncStorage.setItem(SAF_DIRECTORY_URI_KEY, result.directoryUri);
  return getDirectoryDisplayName(result.directoryUri);
}

/**
 * Bu boyutun üstündeki dosyalar için kopyalama denenmiyor - bkz.
 * copyIntoSafDirectory. Kopyalama tepe belleği yaklaşık dosya boyutunun iki
 * katı olduğundan, sessizce OOM ile çökmek yerine anlaşılır bir hata veriyoruz.
 */
const MAX_SAF_COPY_BYTES = 256 * 1024 * 1024;

/** Dosya paylaşılan depolamaya sığmayacak kadar büyük. */
export class FileTooLargeToSaveError extends Error {
  constructor(message = 'Dosya bu cihazda kaydedilemeyecek kadar büyük') {
    super(message);
    this.name = 'FileTooLargeToSaveError';
  }
}

async function copyIntoSafDirectory(
  directoryUri: string,
  localUri: string,
  baseName: string,
  mimeType: string
): Promise<string> {
  // Boyut kontrolü dosyayı hedefte OLUŞTURMADAN önce - başarısız olacaksa
  // kullanıcının klasöründe 0 baytlık artık bırakmayalım.
  const source = new File(localUri);
  if (source.exists && source.size > MAX_SAF_COPY_BYTES) {
    throw new FileTooLargeToSaveError();
  }

  const targetUri = await StorageAccessFramework.createFileAsync(directoryUri, baseName, mimeType);

  // StorageAccessFramework.copyAsync({from, to}) burada KULLANILAMAZ — kök
  // neden kurulu paketin kendi native kaynağında (node_modules/expo-file-system/
  // android/.../legacy/FileSystemLegacyModule.kt, "copyAsync" fonksiyonu)
  // doğrulandı: `from` bir file:// URI'si olduğunda kod `to`'nun şemasını HİÇ
  // kontrol etmeden doğrudan `toUri.toFile()` çağırıyor. `to` bizim content://
  // SAF URI'mizse, bu URI'nin path bileşenini (örn.
  // "/tree/primary:X/document/primary:X") düz bir dosya sistemi yolu gibi
  // yorumlayıp oraya yazmaya çalışıyor — "directory cannot be created" hatası
  // buradan geliyor, hangi klasör seçilirse seçilsin, önbellekle ilgisi yok.
  // Doğru/dokümante edilen yol: writeAsStringAsync'in kullandığı
  // getOutputStream() yardımcı fonksiyonu content:// URI'ler için doğru
  // şekilde context.contentResolver.openOutputStream(uri) kullanıyor (aynı
  // dosyada doğrulandı).
  //
  // GÜNCELLEME - base64 turu kaldırıldı. Önceden kaynak base64 STRING olarak
  // okunup hedefe base64 yazılıyordu; bu, dosya boyutunun ~5 katı tepe bellek
  // demekti (base64 %33 şişme + JS string'inin UTF-16 olarak 2 bayt/karakter
  // tutulması + native ara kopya). 200 MB'lık bir arşiv ~1 GB tepe yapıyor ve
  // Android'in uygulama yığın sınırını (~128-512 MB) aşıp çöküyordu.
  //
  // Yeni API'nin File.write(Uint8Array) metodu content:// URI'leri AÇIKÇA
  // destekliyor (kurulu paketin native kaynağında doğrulandı:
  // FileSystemFile.kt, `fun write(content: TypedArray)` -> `if
  // (uri.isContentUri) file.outputStream()`, SAFDocumentFile.outputStream()
  // ise contentResolver.openOutputStream kullanıyor). Böylece base64 hiç
  // devreye girmiyor, tepe bellek ~2 kata iniyor.
  //
  // Gerçek akışlı (stream) kopyalama bu paket sürümünde MÜMKÜN DEĞİL:
  // writeAsStringAsync'in append/mode seçeneği yok, FileHandle
  // RandomAccessFile üzerinden çalıştığı için content:// kabul etmiyor ve
  // File.copy() içeride destination.javaFile çağırıp content URI'de
  // fırlatıyor (üçü de native kaynakta doğrulandı). Bu yüzden üstte bir
  // boyut tavanı var.
  try {
    const bytes = await new File(localUri).bytes();
    new File(targetUri).write(bytes);
  } catch (e) {
    // createFileAsync hedefte dosyayı ZATEN oluşturdu. Yazma başarısız olursa
    // (bellek yetmedi, disk doldu) kullanıcının klasöründe açılmayan 0 baytlık
    // bir artık kalıyordu - temizleyip hatayı yukarı veriyoruz.
    try {
      await FileSystem.deleteAsync(targetUri, { idempotent: true });
    } catch (cleanupError) {
      console.warn('[sharedStorage] Yarım kalan hedef dosya silinemedi', cleanupError);
    }
    throw e;
  }
  return targetUri;
}

/**
 * İndirilen dosyayı (sandbox'taki geçici konumdan) cihazın paylaşılan
 * depolamasına kopyalar — resim/video için medya kütüphanesine, diğer
 * dosya tipleri için Aktarım sekmesinden önceden seçilmiş klasöre. Picker'ı
 * KENDİSİ AÇMAZ — önbellekte klasör yoksa (hiç seçilmemiş ya da geçersiz
 * hâle gelmiş) DownloadFolderNotSetError fırlatır, kullanıcı Aktarım'dan
 * elle seçmeli.
 */
/**
 * Dosyanın nereye kaydedildiği. Arayüz bunu kullanıcıya söyleyebilsin diye
 * dönülüyor: resim/video seçilen klasöre DEĞİL galeriye gidiyor ve bu, kartta
 * "İNDİRME KLASÖRÜ" yazarken kafa karıştırıcıydı.
 */
export type SaveTarget =
  | { kind: 'gallery' }
  /** mimeType, dosyayı sonradan doğru uygulamayla açabilmek için taşınıyor. */
  | { kind: 'folder'; uri: string; mimeType: string }
  | { kind: 'unsupported' };

export async function saveToSharedStorage(
  localUri: string,
  fileName: string,
  mimeType: string | null
): Promise<SaveTarget> {
  if (Platform.OS !== 'android') return { kind: 'unsupported' };

  // Sunucudan gelen mimeType yerine önce dosya adının uzantısından türetiyoruz
  // (bkz. EXTENSION_MIME_TYPES üstündeki not) — hem MediaLibrary/SAF yönlendirme
  // kararı hem de SAF'a yazılacak gerçek mimeType için tek, güvenilir kaynak.
  const resolvedMimeType = getMimeTypeFromFileName(fileName) ?? mimeType ?? 'application/octet-stream';

  if (isImageOrVideoMimeType(resolvedMimeType)) {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) {
      throw new SharedStoragePermissionDeniedError();
    }

    // Not: saveToLibraryAsync'in dönüş tipi Promise<void> — geri dönen bir
    // asset nesnesi yok (kurulu paketin tipinden doğrulandı).
    await MediaLibrary.saveToLibraryAsync(localUri);
    return { kind: 'gallery' };
  }

  // SAF'ta createFile(mimeType, displayName) uzantıyı SADECE mimeType'tan
  // türetiyor, bu yüzden bilinen bir tür için adı uzantısız veriyoruz.
  // Ama tür BİLİNMİYORSA (uzantı EXTENSION_MIME_TYPES tablosunda yok ->
  // application/octet-stream) Android hangi uzantıyı ekleyeceğini bilemiyor
  // ve "notlar.xyz" dosyası hedefte "notlar" olarak kalıyordu. O durumda tam
  // adı veriyoruz ki uzantı en azından adın içinde korunsun.
  const mimeTypeIsKnown = getMimeTypeFromFileName(fileName) !== null;
  const dotIndex = fileName.lastIndexOf('.');
  const baseName = mimeTypeIsKnown && dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;

  const directoryUri = await AsyncStorage.getItem(SAF_DIRECTORY_URI_KEY);
  if (!directoryUri) throw new DownloadFolderNotSetError();

  try {
    const uri = await copyIntoSafDirectory(directoryUri, localUri, baseName, resolvedMimeType);
    return { kind: 'folder', uri, mimeType: resolvedMimeType };
  } catch (e) {
    if (!isInvalidDirectoryError(e)) throw e;
    // Önbellekteki klasör artık geçersiz — temizle ki bir dahaki indirmede
    // aynı bozuk değer tekrar kullanılmasın. Otomatik olarak picker AÇMA;
    // kullanıcı Aktarım sekmesinden bilinçli olarak yeniden seçmeli.
    await AsyncStorage.removeItem(SAF_DIRECTORY_URI_KEY);
    console.warn('[sharedStorage] Önbellekteki hedef klasör geçersizmiş, temizlendi:', e);
    throw new DownloadFolderNotSetError();
  }
}

/** openSavedFile sonucu — arayüz buna göre mesaj gösteriyor. */
export type OpenResult = 'opened' | 'missing' | 'no-app' | 'failed';

/**
 * Kaydedilmiş bir dosyayı sistemin varsayılan uygulamasıyla açar.
 *
 * content:// URI'yi başka bir uygulamaya vermek TEK BAŞINA yetmiyor: SAF ile
 * bize verilen okuma izni varsayılan olarak alıcı uygulamaya geçmiyor. Bu
 * yüzden FLAG_GRANT_READ_URI_PERMISSION (0x1) gönderiliyor; onsuz hedef
 * uygulama "izin yok" hatasıyla açılıyor.
 */
export async function openSavedFile(uri: string, mimeType: string | null): Promise<OpenResult> {
  if (Platform.OS !== 'android') return 'failed';

  // Dosya kullanıcı tarafından silinmiş/taşınmış olabilir. Açmayı denemeden
  // önce bakıyoruz ki "Dosya bulunamadı" uyarısı gerçekten doğru olsun.
  // (Yeni File API content:// URI'leri destekliyor — SAFDocumentFile üzerinden.)
  try {
    if (!new File(uri).exists) return 'missing';
  } catch {
    return 'missing';
  }

  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: uri,
      type: mimeType ?? 'application/octet-stream',
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    });
    return 'opened';
  } catch (e) {
    // Bu türü açabilen bir uygulama yoksa Android ActivityNotFoundException
    // fırlatıyor — bu bir hata değil, kullanıcıya ayrı bir mesaj gerektiriyor.
    const message = e instanceof Error ? e.message : String(e);
    if (/ActivityNotFound|No Activity found/i.test(message)) return 'no-app';
    console.warn('[sharedStorage] Dosya açılamadı', e);
    return 'failed';
  }
}
