import express from "express";
import { config, configureFromEnv } from "./config";
import { touch } from "./lastSeen";
import { devicesRouter } from "./routes/devices";
import { filesRouter } from "./routes/files";
import { messagesRouter } from "./routes/messages";
import { cleanupOrphanedTempUploads, cleanupOrphanedMetaFiles } from "./upload";
import { requireAuth } from "./authMiddleware";

/**
 * Express app'ini kurar (route'lar, middleware) ama DİNLEMEYE BAŞLAMAZ —
 * bunu ayrı tutmak, bu modülün bir kütüphane olarak (ör. deneme-desktop'ın
 * Electron ana süreci, kendi start/stop kontrolü için) import edilebilmesini
 * sağlıyor. CLI kullanımı (aşağıdaki startCli) bunu çağırıp kendi .listen()'ini
 * yapıyor; davranış öncekiyle birebir aynı.
 */
export function createApp(): express.Express {
  const app = express();

  app.use((req, _res, next) => {
    const deviceId = req.header("X-Device-Id");
    if (deviceId) touch(deviceId);
    next();
  });

  app.get("/ping", (_req, res) => {
    res.json({
      ok: true,
      server: config.serverName,
      timestamp: new Date().toISOString(),
    });
  });

  // Aktarım geçmişi: kaydı yalnızca gömülü sunucuyu çalıştıran makine
  // tutuyor (bkz. config.getTransfers). Uç, o kayıt varsa açılır; telefon
  // da böylece aynı geçmişi görebiliyor.
  app.get("/api/transfers", requireAuth, (_req, res) => {
    if (!config.getTransfers) {
      res.status(501).json({ ok: false, error: "Bu sunucuda aktarım geçmişi tutulmuyor" });
      return;
    }
    res.json({ ok: true, transfers: config.getTransfers() });
  });

  app.use("/api/devices", devicesRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/messages", messagesRouter);

  return app;
}

/** Açılışta kalıntı geçici yükleme dosyalarını temizler; başarısız olsa da sunucu açılmaya devam etmeli. */
export async function runStartupCleanup(): Promise<void> {
  try {
    const deleted = await cleanupOrphanedTempUploads();
    if (deleted > 0) {
      console.log(`Açılış temizliği: .tmp-uploads içinden ${deleted} kalıntı girdi silindi.`);
    }
  } catch (err) {
    console.warn("Açılış temizliği başarısız oldu, sunucu yine de açılıyor:", err);
  }

  // Ayrı try: meta temizliği başarısız olsa da yukarıdaki temizliğin sonucu
  // korunmalı ve sunucu yine açılmalı.
  try {
    const orphanMeta = await cleanupOrphanedMetaFiles();
    if (orphanMeta > 0) {
      console.log(`Açılış temizliği: eşi olmayan ${orphanMeta} .meta.json dosyası silindi.`);
    }
  } catch (err) {
    console.warn("Meta temizliği başarısız oldu, sunucu yine de açılıyor:", err);
  }
}

async function startCli(): Promise<void> {
  try {
    configureFromEnv();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  await runStartupCleanup();
  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`deneme-server (${config.serverName}) dinliyor: ${config.host}:${config.port}`);
  });
}

// Bu dosya doğrudan çalıştırıldığında (CLI/systemd) otomatik başlar; bir
// kütüphane olarak import edildiğinde (ör. deneme-desktop) HİÇBİR ŞEY
// otomatik başlamaz — tüketici createApp()/runStartupCleanup()'ı kendi
// zamanlamasıyla çağırır.
if (require.main === module) {
  startCli();
}
