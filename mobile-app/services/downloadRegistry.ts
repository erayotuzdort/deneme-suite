/**
 * İndirilen dosyaların NEREYE kaydedildiğini hatırlar.
 *
 * Neden gerekli: Bildirimler ekranında bir kayda dokununca dosyanın açılması
 * isteniyor. Ama sunucudan gelen aktarım kaydı yalnızca SUNUCUDAKİ yolu
 * (savedPath) biliyor — telefondaki kopyanın nerede olduğunu bilmiyor. SAF'a
 * yazılan dosyanın content:// URI'si yalnızca indirme anında elimizde oluyor,
 * o yüzden burada saklıyoruz.
 *
 * Eşleştirme dosya ADIYLA yapılıyor: aktarım kaydının fileName'i ile indirme
 * anındaki fileName aynı. Aynı adlı dosya iki kez indirilirse sonuncusu geçerli
 * olur — kullanıcı açısından doğru davranış.
 *
 * PLATFORMA ÖZEL DEĞİL: yalnızca '@/services/localStore' importu alias'lanıyor.
 */
import { readJson, writeJson } from '@/services/localStore';

const KEY = 'savedDownloads:v1';
/** Kayıt sınırsız büyümesin; en yeni bu kadarı yeter. */
const MAX_ENTRIES = 300;

export type SavedLocation =
  /** Kullanıcının seçtiği SAF klasörüne yazıldı — content:// URI ile açılabilir. */
  | { kind: 'folder'; uri: string; mimeType: string | null; at: number }
  /** Resim/video medya kütüphanesine gitti — URI dönmüyor, açmak yerine yönlendiriyoruz. */
  | { kind: 'gallery'; at: number };

type Registry = Record<string, SavedLocation>;

export async function rememberSavedFile(fileName: string, location: SavedLocation): Promise<void> {
  const reg = await readJson<Registry>(KEY, {});
  reg[fileName] = location;

  const names = Object.keys(reg);
  if (names.length > MAX_ENTRIES) {
    // En eski kayıtları at (at = kaydedilme zamanı).
    names
      .sort((a, b) => reg[a].at - reg[b].at)
      .slice(0, names.length - MAX_ENTRIES)
      .forEach((n) => delete reg[n]);
  }
  await writeJson(KEY, reg);
}

export async function findSavedFile(fileName: string): Promise<SavedLocation | null> {
  const reg = await readJson<Registry>(KEY, {});
  return reg[fileName] ?? null;
}

/** Kullanıcı bir kaydı sildiğinde ilgili girdi de gitsin. */
export async function forgetSavedFiles(fileNames: string[]): Promise<void> {
  if (fileNames.length === 0) return;
  const reg = await readJson<Registry>(KEY, {});
  let changed = false;
  for (const n of fileNames) {
    if (n in reg) {
      delete reg[n];
      changed = true;
    }
  }
  if (changed) await writeJson(KEY, reg);
}
