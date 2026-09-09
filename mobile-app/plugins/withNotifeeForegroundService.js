const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

// Notifee'nin (@notifee/react-native) kendi Expo config plugin'i yok. Gerekli
// izinler app.json'daki android.permissions üzerinden eklendi (standart Expo
// mekanizması); ama <service> tanımı (foregroundServiceType dahil) için Expo'nun
// hazır bir config alanı yok, bu yüzden elle ekliyoruz. Servis sınıfının adı
// ("app.notifee.core.ForegroundService") Notifee'nin native çekirdeğinden gelir,
// kütüphanenin kendi belgelerinde manuel eklenmesi gereken bir örnek olarak
// gösteriliyor: https://notifee.app/react-native/docs/android/foreground-service
const NOTIFEE_FOREGROUND_SERVICE_NAME = 'app.notifee.core.ForegroundService';
const FOREGROUND_SERVICE_TYPE = 'dataSync';

function withNotifeeForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    mainApplication.service = mainApplication.service ?? [];

    const alreadyDeclared = mainApplication.service.some(
      (service) => service.$['android:name'] === NOTIFEE_FOREGROUND_SERVICE_NAME
    );
    if (!alreadyDeclared) {
      mainApplication.service.push({
        $: {
          'android:name': NOTIFEE_FOREGROUND_SERVICE_NAME,
          'android:foregroundServiceType': FOREGROUND_SERVICE_TYPE,
          'android:exported': 'false',
        },
      });
    }

    return config;
  });
}

module.exports = withNotifeeForegroundService;
