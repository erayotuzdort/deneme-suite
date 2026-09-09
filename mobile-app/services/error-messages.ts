/**
 * Hataları kullanıcıya gösterilecek Türkçe metne çeviren TEK kaynak.
 *
 * Bu dosya PLATFORMA ÖZEL DEĞİL - masaüstü uygulaması da (react-native-web
 * üzerinden aynı ekranları kullandığı için) buradan geçiyor. Yalnızca
 * '@/services/api' importu platforma göre çözümleniyor; iki tarafta da aynı
 * hata sınıfları dışa aktarıldığından kod ortak kalabiliyor.
 *
 * Neden var: ekranlarda `instanceof` zinciri
 * ApiNotConfigured -> NotPaired -> Unauthorized401 ile bitiyor, geri kalan HER
 * ŞEY son else dalında "Sunucuya ulaşılamıyor" oluyordu. Sunucu ayakta olup
 * 500 döndürdüğünde bile kullanıcı ağ/Tailscale hata ayıklamaya yönlendiriliyor,
 * asıl sorunun sunucuda olduğunu gösteren hiçbir ipucu görmüyordu.
 * ApiRequestError tanımlı, fırlatılıyor ve dışa aktarılıyordu ama hiçbir ekran
 * onu yakalamıyordu - artık burada yakalanıyor.
 */
import {
  ApiNotConfiguredError,
  ApiRequestError,
  ApiUnreachableError,
  DownloadFolderNotSetError,
  FileTooLargeToSaveError,
  NotPairedError,
  RequestCancelledError,
  SharedStoragePermissionDeniedError,
  Unauthorized401Error,
} from '@/services/api';

/** Ekranın hatanın yanında hangi eylemi sunacağı. */
export type ErrorAction = 'configure-server' | 'pair-device' | 'choose-folder' | 'retry' | 'none';

export type ErrorPresentation = {
  /** Kullanıcıya gösterilecek kısa metin. */
  message: string;
  /** Dar alanlar (durum rozeti, kart) için tek-iki kelimelik sürüm. */
  short: string;
  /** Varsa, altında gösterilecek açıklayıcı ikinci satır. */
  hint?: string;
  action: ErrorAction;
  /** false ise bu bir hata değil, bilgilendirme (ör. henüz yapılandırılmamış). */
  isFailure: boolean;
};

export function describeError(e: unknown): ErrorPresentation {
  if (e instanceof ApiNotConfiguredError) {
    return {
      message: 'Sunucu adresi ayarlanmamış',
      short: 'Adres yok',
      action: 'configure-server',
      isFailure: false,
    };
  }
  if (e instanceof NotPairedError) {
    return {
      message: 'Bu cihaz eşleştirilmemiş',
      short: 'Eşleştirilmemiş',
      hint: 'Aktarım sekmesinden ekleyebilirsin',
      action: 'pair-device',
      isFailure: false,
    };
  }
  if (e instanceof Unauthorized401Error) {
    return {
      message: 'Bağlantı koptu, yeniden eşleştirmen gerekiyor',
      short: 'Yetki yok',
      action: 'pair-device',
      isFailure: true,
    };
  }
  if (e instanceof RequestCancelledError) {
    return { message: 'İstek iptal edildi', short: 'İptal edildi', action: 'retry', isFailure: false };
  }
  if (e instanceof DownloadFolderNotSetError) {
    return {
      message: 'Önce bir indirme klasörü seç',
      short: 'Klasör seçilmedi',
      action: 'choose-folder',
      isFailure: false,
    };
  }
  if (e instanceof SharedStoragePermissionDeniedError) {
    return {
      message: 'Depolama izni verilmedi, dosya kaydedilemedi',
      short: 'İzin yok',
      hint: 'Android ayarlarından uygulamaya medya izni ver',
      action: 'none',
      isFailure: true,
    };
  }
  if (e instanceof FileTooLargeToSaveError) {
    return {
      message: 'Dosya bu cihazda kaydedilemeyecek kadar büyük',
      short: 'Çok büyük',
      hint: 'Bu dosyayı masaüstü uygulamasından indir',
      action: 'none',
      isFailure: true,
    };
  }
  // Sunucu CEVAP VERDİ ama isteği reddetti - "ulaşılamıyor" demek yanlış yönlendirir.
  if (e instanceof ApiRequestError) {
    if (e.status === 404) {
      return {
        message: 'Sunucu bu dosyayı ya da klasörü bulamadı',
        short: 'Bulunamadı',
        hint: 'Taşınmış veya silinmiş olabilir',
        action: 'retry',
        isFailure: true,
      };
    }
    if (e.status === 403) {
      return {
        message: 'Sunucu erişimi reddetti',
        short: 'Reddedildi',
        hint: 'Bu yol için yetkin yok',
        action: 'none',
        isFailure: true,
      };
    }
    if (e.status >= 500) {
      return {
        message: 'Sunucu hata verdi',
        short: 'Sunucu hatası',
        hint: `Sunucu çalışıyor ama isteği tamamlayamadı (${e.status})`,
        action: 'retry',
        isFailure: true,
      };
    }
    return {
      message: e.message || 'Sunucu isteği reddetti',
      short: 'İstek reddedildi',
      hint: e.status > 0 ? `Durum kodu ${e.status}` : undefined,
      action: 'retry',
      isFailure: true,
    };
  }
  if (e instanceof ApiUnreachableError) {
    return {
      message: 'Sunucuya ulaşılamıyor',
      short: 'Bağlanamıyor',
      hint: 'Sunucu kapalı ya da ağ erişilemez durumda',
      action: 'retry',
      isFailure: true,
    };
  }
  return { message: 'Beklenmeyen bir hata oluştu', short: 'Hata', action: 'retry', isFailure: true };
}
