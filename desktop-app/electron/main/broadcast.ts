import { BrowserWindow } from 'electron';

/**
 * Açık pencerelere olay yayınlar.
 *
 * Neden ayrı bir yardımcı: `win.webContents.send(...)` YIKILMIŞ bir
 * webContents üzerinde çağrılırsa hata fırlatır. Uygulama kapanırken ya da
 * pencere yeniden oluşturulurken, arka planda süren bir indirme/aktarım
 * olayı tam o anda yayın yapmaya çalışabiliyor. Üç ayrı yerde (indirme
 * ilerlemesi, sunucu durumu, aktarım geçmişi) aynı korumasız desen vardı;
 * hepsi buraya toplandı.
 */
export function broadcastToWindows(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      if (payload === undefined) win.webContents.send(channel);
      else win.webContents.send(channel, payload);
    } catch {
      // Pencere iki kontrol arasında kapanmış olabilir - yayın, işin
      // kendisinden daha önemli değil.
    }
  }
}
