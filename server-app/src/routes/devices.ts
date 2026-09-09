import { Router } from "express";
import { requireAuth } from "../authMiddleware";
import { listDevicesWithStatus, removeDeviceCompletely, DEVICE_ID_PATTERN } from "../pair";

export const devicesRouter = Router();

devicesRouter.use(requireAuth);

devicesRouter.get("/", async (_req, res) => {
  const devices = await listDevicesWithStatus();
  res.json({ ok: true, devices });
});

// Sahiplik/admin ayrımı yok (bkz. proje kuralları) — herhangi bir kimliği
// doğrulanmış cihaz herhangi bir cihazı (kendisi dahil) çıkarabilir. Kendini
// çıkaran cihazın token'ı hemen geçersiz olur, bir sonraki isteğinde 401
// alır — bu, uygulamanın zaten sahip olduğu "yeniden eşleştir" akışına
// doğal olarak düşer.
devicesRouter.delete("/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    res.status(400).json({ ok: false, error: "Geçersiz cihaz kimliği" });
    return;
  }

  const removed = await removeDeviceCompletely(deviceId);
  if (!removed) {
    res.status(404).json({ ok: false, error: "Cihaz bulunamadı" });
    return;
  }

  res.json({ ok: true });
});
