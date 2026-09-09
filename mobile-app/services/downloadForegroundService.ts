import notifee, { AndroidForegroundServiceType, AndroidImportance } from '@notifee/react-native';
import { Platform } from 'react-native';

// Android'de büyük bir indirme, uygulama arka plana alındığında/kilit ekranı
// açıldığında sistem tarafından duraklatılabilir. Bunu önlemek için gerçek bir
// Android foreground service + kalıcı bildirim gerekiyor (bkz. C1-HAZIRLIK.md
// madde 13). iOS'ta bu kavram yok, bu yüzden tüm fonksiyonlar Android dışında
// no-op'tur.
const CHANNEL_ID = 'downloads';
const NOTIFICATION_ID = 'active-download';

let channelReady: Promise<void> | null = null;

// createDownloadResumable'ın son ilerleme geri çağırımı (%100) ile
// downloadAsync()'in çözülmesi/stopDownloadNotification() çağrısı arasında
// bir yarış vardı: geç gelen bir updateDownloadProgress çağrısı,
// stopForegroundService() servisi kapattıktan SONRA foreground bildirimini
// yeniden oluşturabiliyordu — bildirim %100'de kalıcı olarak takılı
// kalıyordu. Bu bayrak, her indirim döngüsü için o son yarışı engeller.
let downloadActive = false;

/**
 * channelReady, kanal bir kere oluşturulduktan sonra tekrar tekrar
 * oluşturmamak için promise'i önbelleğe alır. createChannel geçici bir
 * nedenle (ör. bildirim yöneticisi henüz hazır değilken) reddederse, bu
 * reddedilmiş promise'i sonsuza dek önbellekte tutmamalıyız — aksi halde
 * uygulama o oturum boyunca kanalı bir daha hiç oluşturamaz ve tüm indirme
 * bildirimleri sessizce başarısız olmaya devam eder ("bazen hiç çıkmıyor"
 * belirtisiyle örtüşen bir olası kök neden). Başarısız olursa önbelleği
 * temizleyip bir sonraki çağrının yeniden denemesine izin veriyoruz.
 */
function ensureChannel(): Promise<void> {
  if (!channelReady) {
    channelReady = notifee
      .createChannel({ id: CHANNEL_ID, name: 'Dosya indirmeleri', importance: AndroidImportance.LOW })
      .then(() => undefined)
      .catch((e) => {
        channelReady = null;
        throw e;
      });
  }
  return channelReady;
}

function buildBody(fileName: string, percent?: number): string {
  return percent === undefined ? fileName : `${fileName} — %${percent}`;
}

/**
 * Uygulama başlarken (React bileşenlerinin dışında) bir kere çağrılmalı.
 * Notifee'nin foreground service'i, bu geri çağırım kayıtlı olmadan
 * başlatılamaz. Promise kasıtlı olarak hiç çözülmez — servisin ömrünü
 * stopDownloadNotification()'daki stopForegroundService() çağrısı bitirir.
 */
export function registerDownloadForegroundService(): void {
  if (Platform.OS !== 'android') return;
  notifee.registerForegroundService(() => new Promise(() => {}));
}

/**
 * İndirme başlarken kalıcı bildirimi gösterir. Başarısız olursa indirmeyi
 * ENGELLEMEZ ama artık sessiz de kalmaz: dönüş değeri, foreground service'in
 * gerçekten ayağa kalkıp kalkmadığını söyler.
 *
 * Neden önemli: Android 13+'ta kullanıcı bildirim iznini reddederse foreground
 * service bildirimi gösterilemez, dolayısıyla servis de başlamaz. İndirme
 * çalışmaya devam eder ama uygulama arka plana alınıp ekran kilitlendiğinde
 * sistem tarafından durdurulabilir. Eskiden bu yalnızca console.warn'a
 * yazılıyordu; çağıran taraf indirmenin "korumalı" olduğunu varsayıyordu.
 */
export async function startDownloadNotification(fileName: string): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  downloadActive = true;
  try {
    const permission = await notifee.requestPermission();
    if (permission.authorizationStatus <= 0) {
      console.warn('Bildirim izni yok: indirme sürecek ama arka planda korunmayacak');
      return false;
    }
    await ensureChannel();
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Dosya indiriliyor',
      body: buildBody(fileName),
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        ongoing: true,
        onlyAlertOnce: true,
        progress: { indeterminate: true },
      },
    });
    return true;
  } catch (e) {
    console.warn('İndirme bildirimi gösterilemedi', e);
    return false;
  }
}

/** İlerlemeyi mevcut bildirimde günceller (aynı id, yeniden oluşturmaz). */
export async function updateDownloadProgress(fileName: string, writtenBytes: number, totalBytes: number): Promise<void> {
  if (Platform.OS !== 'android' || !downloadActive) return;
  try {
    const percent = totalBytes > 0 ? Math.round((writtenBytes / totalBytes) * 100) : undefined;
    await ensureChannel();
    // indirme bu await sırasında bitmiş (stopDownloadNotification çağrılmış)
    // olabilir — o zaman bildirimi yeniden canlandırma.
    if (!downloadActive) return;
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Dosya indiriliyor',
      body: buildBody(fileName, percent),
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        ongoing: true,
        onlyAlertOnce: true,
        progress: percent === undefined ? { indeterminate: true } : { max: 100, current: percent },
      },
    });
  } catch (e) {
    console.warn('İndirme bildirimi güncellenemedi', e);
  }
}

type DownloadOutcome = { success: boolean; fileName?: string };

/**
 * İndirme bitince servisi (ve onunla birlikte kalıcı bildirimi) kapatır,
 * ardından kısa ömürlü, kalıcı OLMAYAN bir sonuç bildirimi gösterir
 * ("İndirildi" ya da "İndirme başarısız") — bu, birkaç saniye sonra
 * kendiliğinden kaybolur, sessizce %100'de takılı kalmaz.
 */
export async function stopDownloadNotification(outcome: DownloadOutcome = { success: true }): Promise<void> {
  if (Platform.OS !== 'android') return;
  // Bayrağı ilk iş olarak, herhangi bir await'ten önce indiriyoruz ki
  // aynı anda gecikmiş bir updateDownloadProgress çağrısı bildirimi
  // yeniden foreground service olarak canlandırmasın.
  downloadActive = false;

  try {
    await notifee.stopForegroundService();
  } catch (e) {
    console.warn('İndirme bildirimi kapatılamadı', e);
  }

  try {
    await ensureChannel();
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: outcome.success ? 'İndirildi' : 'İndirme başarısız',
      body: outcome.fileName,
      android: {
        channelId: CHANNEL_ID,
        autoCancel: true,
        timeoutAfter: 5000,
      },
    });
  } catch (e) {
    console.warn('İndirme sonucu bildirimi gösterilemedi', e);
  }
}
