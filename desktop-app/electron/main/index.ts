import { app } from 'electron';
import path from 'node:path';

/**
 * deneme-server'ın pair.ts/auth.ts modülleri DEVICES_FILE/TOKENS_FILE ortam
 * değişkenlerini MODÜL YÜKLENME ANINDA okuyor (export const DEFAULT_..., bkz.
 * deneme-server/src/pair.ts ve auth.ts). Rollup, main süreci TEK bir bundle
 * dosyasında birleştirdiğinden ve TÜM static (harici paket) import'ları o
 * dosyanın en başına topladığından - bu dosyanın kendi içine ARAYA
 * sıkıştırılmış bir "process.env.X = ..." satırı İŞE YARAMAZ: aynı bundle
 * içindeki 'deneme-server/pair' importu, o satırdan HER ZAMAN önce evaluate
 * olur (statik import'lar hoisted'dır, atama satırı değildir). Bunu
 * doğrulanmış kanıtla tespit ettik (bkz. oturum notları - dist-electron
 * çıktısını inceleyip import sırasını kontrol ettik).
 *
 * Çözüm: gerçek uygulama mantığını (deneme-server'ı transitive olarak import
 * eden HER ŞEY) DİNAMİK import() ile yükle. Dinamik import statik hoisting'e
 * tabi DEĞİL - Rollup bunu AYRI bir chunk olarak derliyor, o chunk'ın kendi
 * top-level kodu (dolayısıyla deneme-server/pair'in importu) SADECE bu
 * satır fiilen ÇALIŞTIĞINDA evaluate oluyor - yani env değişkenleri zaten
 * set edildikten SONRA.
 *
 * Paketlenmiş uygulamada deneme-server'ın kendi modül dizini app.asar
 * içinde salt-okunur - devices.json/tokens.json'ı oraya (varsayılan
 * path.join(__dirname, '..', 'devices.json') vb.) yazmaya çalışmak
 * "ENOENT: ... app.asar\node_modules\deneme-server\tokens.json" ile
 * çöküyordu. crash.log'un zaten kullandığı AYNI yazılabilir userData
 * klasörüne yönlendiriyoruz - Electron bu klasörün varlığını kendisi
 * garanti ediyor (settings.ts/credentials.ts'in electron-store dosyaları
 * da buraya, hiçbir ek mkdir olmadan yazıyor).
 */
process.env.DEVICES_FILE = path.join(app.getPath('userData'), 'devices.json');
process.env.TOKENS_FILE = path.join(app.getPath('userData'), 'tokens.json');

await import('./app-main');
