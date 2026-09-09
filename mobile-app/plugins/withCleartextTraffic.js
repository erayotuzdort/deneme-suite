const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

// Android 9'dan (API 28) itibaren `android:usesCleartextTraffic` varsayılanı
// FALSE'tur: TLS'siz düz http:// istekleri platform tarafından, uygulama
// koduna hiç ulaşmadan reddedilir (java.io.IOException: "Cleartext HTTP
// traffic to ... not permitted"). React Native'in fetch/XHR katmanı bunu
// sıradan bir ağ hatası olarak yüzeye çıkarır, bu yüzden services/api.ts
// içinde sunucu gerçekten ayaktayken bile ApiUnreachableError'a dönüşür.
//
// Expo'nun prebuild şablonu bu özniteliği SADECE debug varyantının
// manifestine koyar (android/app/src/debug/AndroidManifest.xml, `tools:replace`
// ile). Release varyantı - EAS'teki "preview" ve "production" profilleri - o
// manifesti birleştirmediğinden cleartext kapalı kalır: uygulama Expo Go /
// development build'de çalışır ama preview APK'da tüm istekler başarısız olur.
//
// Bu uygulama ev sunucusuna Tailscale üzerinden düz http:// ile bağlanıyor
// (bkz. app/server-settings.tsx - kullanıcı adresi elle giriyor ve şema
// yazılmazsa http:// ekleniyor). Şifrelemeyi WireGuard tabanlı Tailscale
// tüneli sağladığından burada TLS'siz HTTP kabul edilebilir.
//
// Öznitelik alan adı bazlı değil, uygulama genelidir - daha dar bir
// network_security_config ile yalnızca sunucunun adresine izin vermek
// mümkün olmazdı, çünkü sunucu adresi kullanıcı tarafından serbestçe
// giriliyor (herhangi bir host/IP olabilir) ve Tailscale IP'si değişebilir.
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    mainApplication.$['android:usesCleartextTraffic'] = 'true';
    return config;
  });
}

module.exports = withCleartextTraffic;
