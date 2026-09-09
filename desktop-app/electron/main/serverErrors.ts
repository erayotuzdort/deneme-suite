/**
 * Sunucu başlatma/çalışma sırasında oluşan Node hata kodlarını, kullanıcının
 * ekranda göreceği Türkçe ve GERÇEK sebebi belirten mesajlara çevirir.
 * `context` alanları elde varsa (port, storageRoot) mesaja gömülür; yoksa
 * o kısım atlanır - asla "undefined" gibi bir değer kullanıcıya sızmaz.
 */

export type ServerErrorContext = {
  port?: number;
  storageRoot?: string | null;
};

export function describeServerError(err: NodeJS.ErrnoException, context: ServerErrorContext = {}): string {
  const { port, storageRoot } = context;

  switch (err.code) {
    case 'EADDRINUSE':
      return port != null ? `Port ${port} zaten kullanımda` : 'Seçilen port zaten kullanımda';

    case 'EACCES':
      return port != null
        ? `Port ${port} için izin reddedildi (1024 altındaki portlar yönetici yetkisi gerektirebilir)`
        : 'Port için izin reddedildi';

    case 'EADDRNOTAVAIL':
      return port != null ? `Ağ adresi kullanılamıyor (port: ${port})` : 'Ağ adresi kullanılamıyor';

    case 'ENOENT':
      return storageRoot
        ? `Depo klasörüne erişilemiyor: ${storageRoot} (klasör silinmiş veya taşınmış olabilir)`
        : 'Depo klasörü bulunamadı (silinmiş veya taşınmış olabilir)';

    case 'EPERM':
      return storageRoot
        ? `Depo klasörüne yazma izni yok: ${storageRoot}`
        : 'Depo klasörüne yazma izni yok';

    default:
      return err.message || 'Sunucu beklenmedik bir hatayla karşılaştı';
  }
}
