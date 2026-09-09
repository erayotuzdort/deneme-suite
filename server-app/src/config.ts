import "dotenv/config";
import os from "node:os";

/**
 * Tamamlanan ya da başarısız olan bir dosya aktarımı. Sunucunun kendisi bu
 * olayları SAKLAMAZ — sadece `config.onTransfer` tanımlıysa bildirir. Kalıcı
 * kayıt tamamen tüketicinin işi (bkz. deneme-desktop'ın transfers.ts'i);
 * CLI kullanımında kanca tanımsız kalır ve hiçbir davranış değişmez.
 */
export type TransferEvent = {
  /** incoming: bir cihaz sunucuya dosya YÜKLEDİ. outgoing: bir cihaz sunucudan dosya İNDİRDİ. */
  direction: "incoming" | "outgoing";
  status: "success" | "failed";
  fileName: string;
  /** Depo köküne göreli yol (biliniyorsa). */
  path: string | null;
  sizeBytes: number | null;
  /** İsteği yapan cihazın kimliği (requireAuth'tan). */
  deviceId: string | null;
  /** status === "failed" olduğunda sebep. */
  error?: string;
};

export type AppConfig = {
  host: string;
  port: number;
  serverName: string;
  storageRoot: string;
  /** Aktarım olaylarını dinlemek isteyen tüketici bunu atar; varsayılan yok. */
  onTransfer?: ((event: TransferEvent) => void) | null;
  /**
   * Aktarım geçmişini SAKLAYAN tüketici (deneme-desktop) bunu atarsa
   * GET /api/transfers ucu açılır ve eşleştirilmiş cihazlar (telefon dahil)
   * geçmişi okuyabilir. Atanmazsa uç 501 döner — CLI kullanımında geçmiş
   * tutulmuyor, sunucu kendi başına bir depo oluşturmuyor.
   */
  getTransfers?: (() => unknown[]) | null;
};

/**
 * Mutable, paylaşılan yapılandırma nesnesi. Modül import edilirken hiçbir
 * şey doğrulanmaz/exit edilmez — bu, deneme-server'ın hem CLI olarak (bkz.
 * configureFromEnv, index.ts) hem de bir kütüphane olarak (ör. deneme-desktop,
 * Electron ana sürecinden storageRoot/port'u kullanıcı arayüzünden doğrudan
 * atayarak) tüketilebilmesi için gerekli. Tüm tüketiciler (files.ts, upload.ts,
 * routes/*) config.* alanlarını ÇAĞRI ANINDA okur (import anında değil), bu
 * yüzden alanları sonradan değiştirmek güvenlidir.
 */
export const config: AppConfig = {
  host: "0.0.0.0",
  port: 4000,
  serverName: os.hostname(),
  storageRoot: "",
  onTransfer: null,
  getTransfers: null,
};

/**
 * Kancayı çağırırken tüketicinin fırlattığı bir hatanın isteği bozmasını
 * engeller — bildirim kaydı, dosya aktarımının kendisinden daha önemli değil.
 */
export function emitTransfer(event: TransferEvent): void {
  try {
    config.onTransfer?.(event);
  } catch {
    // yut: bildirim kaydı başarısız olsa da aktarım etkilenmemeli
  }
}

/**
 * CLI/systemd kullanımı için: ortam değişkenlerinden okuyup config'i
 * doldurur. STORAGE_ROOT tanımlı değilse fırlatır (process.exit ETMEZ —
 * bunu çağıran taraf, kendi bağlamına uygun şekilde ele almalı; index.ts'teki
 * CLI girişi bunu yakalayıp process.exit(1) yapıyor).
 */
export function configureFromEnv(): void {
  const storageRoot = process.env.STORAGE_ROOT;
  if (!storageRoot) {
    throw new Error(
      "STORAGE_ROOT tanımlı değil. .env dosyanızda ayarlayın (örnek için .env.example dosyasına bakın)."
    );
  }
  config.host = process.env.HOST ?? "0.0.0.0";
  config.port = process.env.PORT ? Number(process.env.PORT) : 4000;
  config.storageRoot = storageRoot;
}
