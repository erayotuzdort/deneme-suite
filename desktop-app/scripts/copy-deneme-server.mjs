// electron-builder (25+), npm'in "file:" bağımlılıkları için oluşturduğu
// node_modules symlink'ini asar'a paketlerken GÜVENİLİR ŞEKİLDE İZLEMİYOR —
// bilinen, belgelenmiş bir hata (bkz. electron-userland/electron-builder#8401,
// develar/app-builder#120'nin bir yan etkisi: symlink'ler gerçek yola
// çözülüyor ama dosya filtreleme mantığı bunu doğru ele almıyor, paketlenmiş
// uygulamada "Cannot find module 'deneme-server'" ile çöküyor). Aracın kendi
// bakımcısının önerdiği çözüm (npm kullanmaya devam edilecekse): symlink
// yerine gerçek bir kopya kullan. Bu script tam olarak bunu yapıyor.
//
// Sadece dist/ + package.json kopyalanıyor (src/, test/, .git/, node_modules/
// DEĞİL) - deneme-server'ın çalışma zamanı bağımlılıkları (express/multer/
// dotenv) deneme-desktop'ın KENDİ package.json'ında doğrudan bağımlılık
// olarak listeleniyor (bkz. package.json), böylece normal (symlink'siz) npm
// paketleri olarak electron-builder'ın sorunsuz paketlediği node_modules'a
// düzgünce kurulup hoisted oluyorlar.
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(__dirname, '..', '..', 'server-app');
const DEST = path.resolve(__dirname, '..', 'node_modules', 'deneme-server');

if (!existsSync(path.join(SOURCE, 'dist'))) {
  console.error(
    `[copy-deneme-server] ${path.join(SOURCE, 'dist')} bulunamadı - önce deneme-server'da "npm run build" çalıştırılmalı.`
  );
  process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(path.join(SOURCE, 'dist'), path.join(DEST, 'dist'), { recursive: true });
cpSync(path.join(SOURCE, 'package.json'), path.join(DEST, 'package.json'));

console.log(`[copy-deneme-server] ${SOURCE} -> ${DEST} (dist/ + package.json, gerçek kopya)`);
