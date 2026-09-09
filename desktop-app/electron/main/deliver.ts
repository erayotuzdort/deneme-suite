import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import * as ConfigModule from 'deneme-server/config';

import { settings } from './settings';

/**
 * Telefondan gelen dosyayı, kullanıcının masaüstünde seçtiği indirme
 * klasörüne teslim eder.
 *
 * Neden var: depo klasörü (storageRoot) sunucunun paylaşılan ağacı - hem
 * telefon hem masaüstü orayı listeler, dolayısıyla dosyanın oradan
 * KALDIRILMASI listeyi bozardı. Bu yüzden dosya depoda bırakılır ve seçilen
 * klasöre bir KOPYASI konur. Kullanıcı açısından sonuç beklediği gibi:
 * telefondan gönderilen dosya, seçtiği klasörde belirir.
 *
 * İndirme klasörü depo klasörünün kendisiyse kopyalama yapılmaz - dosya
 * zaten oradadır ve kopyalamak "ad (1).jpg" gibi gereksiz ikizler üretirdi.
 */

/**
 * Dosyayı boş bir ada kopyalar ("ad (1).uzanti", "ad (2).uzanti" …).
 *
 * Kopyalama COPYFILE_EXCL ile yapılıyor: "önce var mı diye bak, sonra
 * kopyala" deseni kontrol ile kullanım arasında yarışa açıktı — aynı anda
 * gelen aynı adlı iki dosya aynı hedefi seçip biri diğerinin üzerine
 * yazabiliyordu. EXCL, hedef zaten varsa çekirdek düzeyinde EEXIST döndürür;
 * o durumda bir sonraki ada geçiyoruz.
 */
async function copyToUniqueName(source: string, dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? path.join(dir, fileName) : path.join(dir, `${base} (${i})${ext}`);
    try {
      await fs.copyFile(source, candidate, fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  const fallback = path.join(dir, `${base}-${Date.now()}${ext}`);
  await fs.copyFile(source, fallback);
  return fallback;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * `child`, `parent` ağacının içinde mi (ya da parent'ın kendisi mi)?
 *
 * Eskiden yalnızca dosyanın ÜST KLASÖRÜ indirme klasörüyle karşılaştırılıyordu.
 * Depo kökü ile indirme klasörü aynı olduğunda (yaygın kurulum) depo KÖKÜNE
 * gelen dosyalar doğru şekilde kopyalanmıyor, ama herhangi bir ALT KLASÖRE
 * gelen her dosya indirme klasörüne ikinci bir kopya bırakıyordu: klasör
 * yapısı düzleşiyor ve disk kullanımı ikiye katlanıyordu (ölçümde ~300 MB
 * gereksiz ikiz). Doğru soru "üst klasör eşit mi" değil, "dosya zaten indirme
 * klasörünün ağacında mı".
 */
function isInsideTree(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param storageRelPath Depo köküne göreli yol (sunucunun toDisplayPath çıktısı, ör. "/foto.jpg").
 * @returns Dosyanın kullanıcının klasöründeki yolu; teslim yapılmadıysa null.
 */
export async function deliverToDownloadFolder(storageRelPath: string | null): Promise<string | null> {
  const downloadFolder = settings.get('downloadFolder');
  const storageRoot = ConfigModule.config.storageRoot;
  if (!downloadFolder || !storageRelPath || !storageRoot) return null;

  const source = path.join(storageRoot, storageRelPath.replace(/^[/\\]+/, ''));
  // Dosya zaten indirme klasörünün ağacındaysa (ör. depo kökü = indirme
  // klasörü) kopyalamıyoruz - kullanıcı ona oradan zaten ulaşıyor.
  if (samePath(source, downloadFolder) || isInsideTree(source, downloadFolder)) return source;

  try {
    await fs.mkdir(downloadFolder, { recursive: true });
    return await copyToUniqueName(source, downloadFolder, path.basename(source));
  } catch (err) {
    console.error('[deliver] indirme klasörüne kopyalanamadı:', err);
    return null;
  }
}
