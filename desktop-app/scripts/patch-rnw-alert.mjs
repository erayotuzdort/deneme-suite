// react-native-web'in Alert.alert() TAMAMEN NO-OP (bkz. node_modules/
// react-native-web/dist/exports/Alert/index.js: "static alert() {}", kaynağı
// okunarak doğrulandı). Bu, mobile-app'teki Aktarım ekranının cihaz çıkarma
// onay diyaloğunu masaüstünde SESSİZCE işlevsiz bırakıyordu - "Çıkar"a
// basılsa da hiçbir şey olmuyordu.
//
// Mobil kod (app/(tabs)/aktarim.tsx) DEĞİŞTİRİLEMEDİĞİNDEN (proje kuralı),
// önce vite.config.ts'te "react-native" import'unu kendi shim'imize
// yönlendirmeyi denedik - vite-plugin-rnw'nin KENDİ dahili
// "react-native"->"react-native-web" alias'ı bunun ÖNÜNE geçti (build
// çıktısı ampirik olarak incelendi: shim'in window.alert/confirm çağrıları
// bundle'da hiç yoktu). Bu yüzden copy-deneme-server.mjs ile AYNI desende
// (predev/prebuild'te çalışan bir node_modules patch script'i) daha
// güvenilir bir çözüme geçildi: react-native-web'in KENDİ Alert dosyasını
// (hem ESM hem CJS build'ini - dual-build oldukları zaten bu gece başka bir
// bug için doğrulandı) window.confirm/window.alert tabanlı çalışan bir
// versiyonla DEĞİŞTİRİYORUZ. İdempotent - her npm install/predev'de tekrar
// çalıştırılması güvenli.
//
// mobile-app'te grep'le doğrulanan, gerçekte kullanılan İKİ çağrı deseni
// (başka yok): (a) [{'Vazgeç', style:'cancel'}, {'Çıkar', style:'destructive',
// onPress}] - onay/iptal; (b) buton dizisi yok - basit bilgi mesajı.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RNW_DIST = path.resolve(__dirname, '..', 'node_modules', 'react-native-web', 'dist');

const ALERT_LOGIC = `
function alert(title, message, buttons) {
  var body = message ? title + '\\n\\n' + message : title;
  if (!buttons || buttons.length <= 1) {
    window.alert(body);
    if (buttons && buttons[0] && buttons[0].onPress) buttons[0].onPress();
    return;
  }
  var cancelButton = buttons.filter(function (b) { return b.style === 'cancel'; })[0];
  var confirmButton = buttons.filter(function (b) { return b !== cancelButton; })[0] || buttons[buttons.length - 1];
  if (window.confirm(body)) {
    if (confirmButton && confirmButton.onPress) confirmButton.onPress();
  } else {
    if (cancelButton && cancelButton.onPress) cancelButton.onPress();
  }
}
`.trim();

const ESM_CONTENT = `/**
 * PATCHED - bkz. scripts/patch-rnw-alert.mjs. Orijinal react-native-web
 * Alert.alert() tamamen no-op'tu - burada window.confirm/window.alert
 * tabanlı gerçek çalışan bir versiyonla değiştirildi.
 */

${ALERT_LOGIC}

class Alert {
  static alert(title, message, buttons) {
    alert(title, message, buttons);
  }
}
export default Alert;
`;

const CJS_CONTENT = `"use strict";
/**
 * PATCHED - bkz. scripts/patch-rnw-alert.mjs. Orijinal react-native-web
 * Alert.alert() tamamen no-op'tu - burada window.confirm/window.alert
 * tabanlı gerçek çalışan bir versiyonla değiştirildi.
 */

exports.__esModule = true;
exports.default = void 0;

${ALERT_LOGIC}

class Alert {
  static alert(title, message, buttons) {
    alert(title, message, buttons);
  }
}
var _default = exports.default = Alert;
module.exports = exports.default;
`;

const targets = [
  { file: path.join(RNW_DIST, 'exports', 'Alert', 'index.js'), content: ESM_CONTENT },
  { file: path.join(RNW_DIST, 'cjs', 'exports', 'Alert', 'index.js'), content: CJS_CONTENT },
];

let patchedCount = 0;
const missing = [];
for (const { file, content } of targets) {
  if (!existsSync(file)) {
    missing.push(file);
    continue;
  }
  writeFileSync(file, content, 'utf-8');
  patchedCount += 1;
}

// DERLEMEYİ DURDUR. Eskiden eksik hedefte yalnızca stderr'e yazılıp exit 0
// dönülüyordu: react-native-web'i yükseltip Alert modülünün yolu değiştiğinde
// derleme YEŞİL kalıyor, ama Alert.alert() sessizce yeniden no-op oluyordu -
// yani Aktarım sekmesindeki cihaz çıkarma onayı hiçbir şey yapmıyordu ve bunu
// hiçbir tip kontrolü ya da test yakalamıyordu. Bu yama node_modules'a
// dokunduğu için kırılganlığın tek panzehiri gürültülü başarısızlık.
if (patchedCount !== targets.length) {
  console.error(
    `[patch-rnw-alert] HATA: ${patchedCount}/${targets.length} dosya patch'lendi. Bulunamayanlar:\n` +
      missing.map((f) => `  - ${f}`).join('\n') +
      `\nreact-native-web sürümü Alert modülünün yolunu değiştirmiş olabilir.` +
      `\nscripts/patch-rnw-alert.mjs içindeki hedef yolları güncelleyin;` +
      ` aksi hâlde Alert.alert() sessizce çalışmaz hâle gelir (onay diyalogları kaybolur).`
  );
  process.exit(1);
}

console.log(
  `[patch-rnw-alert] react-native-web Alert.alert() ${patchedCount}/${targets.length} dosyada patch'lendi (window.confirm/window.alert tabanlı).`
);
