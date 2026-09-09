import Store from 'electron-store';

export type DesktopSettings = {
  /** Kullanıcının dialog.showOpenDialog ile seçtiği depo klasörü. Hiçbir varsayılan/sabit yol yok. */
  storageRoot: string | null;
  port: number;
  /** OS düzeyi: Windows'a giriş yapılınca UYGULAMANIN KENDİSİ açılsın mı
   * (app.setLoginItemSettings). Sunucuyla ilgisi yok - uygulama hiç
   * açılmazsa zaten sunucu da açılmaz. */
  autoLaunch: boolean;
  /** Uygulama içi: uygulama (nasıl açılmış olursa olsun - Windows
   * autostart'la ya da elle) açıldığında GÖMÜLÜ SUNUCU kendiliğinden
   * başlasın mı. `autoLaunch`'tan bağımsız, ayrı bir tercih - biri OS'u,
   * biri uygulamanın kendi sunucu davranışını kontrol eder. Varsayılan
   * true: kurulumdan hemen sonra bile "her zaman açık dosya sunucusu"
   * beklentisi karşılansın. */
  autoStartServer: boolean;
  /** İstemci rolünde bağlanılan sunucu adresi (kendi 127.0.0.1'i olabilir, ya da uzak bir Tailscale adresi). */
  serverAddress: string | null;
  /** İstemci rolünde indirilen dosyaların kaydedileceği klasör. */
  downloadFolder: string | null;
  /**
   * Yarıda kalmış parçalı yüklemelerin oturum kimlikleri:
   * "hedefYol|dosyaAdı|boyut" -> uploadId. Bir sonraki denemede sunucudaki
   * GET /upload/status ile karşılaştırılıp kaldığı yerden devam edilir
   * (mobil tarafın AsyncStorage'da yaptığının masaüstü karşılığı).
   * Yükleme tamamlanınca ilgili anahtar siliniyor.
   */
  pendingUploads: Record<string, string>;
};

export const settings = new Store<DesktopSettings>({
  defaults: {
    storageRoot: null,
    port: 4000,
    autoLaunch: false,
    autoStartServer: true,
    serverAddress: null,
    downloadFolder: null,
    pendingUploads: {},
  },
});

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/**
 * IPC'den gelen port değerinin gerçekten bir port olduğunu doğrular.
 *
 * Neden burada: handler'lar eskiden gelen ne olursa olsun diske yazıyordu.
 * `null` yazıldığında sunucu `listen(null)` ile RASTGELE bir porta bağlanıp
 * "Çalışıyor: 0.0.0.0:null" gösteriyor, telefon bir daha bağlanamıyor ve
 * kullanıcı JSON'u elle düzeltmeden kurtulamıyordu. Tek doğrulama katmanı
 * arayüzdeydi (SunucuScreen.savePort); artık ana süreç de kendi kapısını
 * koruyor.
 */
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** Boş/temizleme anlamında null kabul edilir; aksi hâlde http(s) URL olmalı. */
export function normalizeServerAddress(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false };
  // Sondaki "/" istek yollarıyla birleşince "//api/..." üretiyordu.
  return { ok: true, value: trimmed.replace(/\/+$/, '') };
}
