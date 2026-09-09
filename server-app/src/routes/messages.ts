import { Router } from "express";
import { requireAuth } from "../authMiddleware";
import { listMessages, deleteMessage } from "../messages";
import { StorageRootUnavailableError } from "../files";

export const messagesRouter = Router();

messagesRouter.use(requireAuth);

messagesRouter.get("/", async (_req, res) => {
  try {
    const messages = await listMessages();
    res.json({ ok: true, messages });
  } catch (err) {
    // Depo erişilemezken 200 + boş liste dönmek, kullanıcıya mesajlarının
    // silindiğini düşündürüyordu; diğer uçlarla aynı 503'ü veriyoruz.
    if (err instanceof StorageRootUnavailableError) {
      res.status(503).json({ ok: false, error: err.message });
      return;
    }
    throw err;
  }
});

// Mesaj id'si (görüntülenebilir yol, ör. "/altklasor/not-....txt") slash
// içerebiliyor - GET /api/files/download?path= ile AYNI ?path= deseni
// kullanılıyor (Express route param'ları slash'i doğal desteklemiyor,
// query param bunu basitçe atlıyor, kod tabanında zaten yerleşik bir kalıp).
// Sahiplik kontrolü YOK (proje kuralı) - herhangi bir kimliği doğrulanmış
// cihaz herhangi bir mesajı silebilir. Sadece isNoteOnly:true meta'ya sahip
// dosyaları siler (bkz. messages.ts) - genel amaçlı bir "dosya sil"
// endpoint'i DEĞİL.
messagesRouter.delete("/", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!rawPath) {
    res.status(400).json({ ok: false, error: "path parametresi gerekli" });
    return;
  }

  const deleted = await deleteMessage(rawPath);
  if (!deleted) {
    res.status(404).json({ ok: false, error: "Mesaj bulunamadı" });
    return;
  }
  res.json({ ok: true });
});
