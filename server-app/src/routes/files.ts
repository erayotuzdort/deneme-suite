import { createReadStream, promises as fs, constants as fsConstants, type Dirent } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config, emitTransfer } from "../config";
import {
  listDirectory,
  resolveExistingFile,
  resolveExistingDirectory,
  toDisplayPath,
  getMimeType,
  assertStorageRootAvailable,
  PathOutsideStorageError,
  DirectoryNotFoundError,
  NotADirectoryError,
  StorageRootUnavailableError,
  FileNotFoundError,
  NotAFileError,
} from "../files";
import {
  uploadMiddleware,
  sanitizeFileName,
  isInvalidFileName,
  claimAvailableName,
  writeMetaFile,
  buildNoteFileName,
  cleanupTempFiles,
  TEMP_UPLOAD_DIR_NAME,
  chunkUploadMiddleware,
  UPLOAD_ID_PATTERN,
  chunkFileName,
  readChunkSession,
  writeChunkSession,
  mergeChunkFiles,
  listReceivedChunkIndexes,
  type ChunkSession,
} from "../upload";
import { requireAuth } from "../authMiddleware";

export const filesRouter = Router();

filesRouter.use(requireAuth);

// --- Aktarım olayları (config.onTransfer) ---
//
// Sonuç, hata dallarının HER BİRİNE tek tek kod eklemek yerine yanıtın
// yaşam döngüsünden okunuyor: 'finish' yanıt eksiksiz gönderildiğinde,
// 'close' ise erken kopmada tetiklenir. Böylece 400/404/416/503, stream
// hatası ve kullanıcının indirmeyi yarıda kesmesi dahil TÜM başarısızlık
// yolları, yeni bir dal eklendiğinde bile otomatik olarak kapsanır.

/** Yanıt gövdesini `res.locals.responseBody`'ye kopyalar — 'finish' anında hata mesajını okuyabilmek için. */
function captureJsonBody(res: import("express").Response): void {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    res.locals.responseBody = body;
    return originalJson(body as never);
  }) as typeof res.json;
}

function bodyError(res: import("express").Response): string | undefined {
  const body = res.locals.responseBody as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : undefined;
}

type DownloadInfo = { fileName: string; displayPath: string; sizeBytes: number };

function watchDownloadOutcome(req: import("express").Request, res: import("express").Response, rawPath: string): void {
  captureJsonBody(res);
  let reported = false;
  const report = (status: "success" | "failed", error?: string) => {
    if (reported) return;
    const info = res.locals.downloadInfo as DownloadInfo | undefined;
    // Başarılı ama downloadInfo yoksa: dosyanın SONUNA ulaşmayan bir ara
    // menzil (Range) yanıtıdır — devam ettirilebilir indirmede her parça
    // için ayrı kayıt oluşmasın diye raporlanmaz.
    if (status === "success" && !info) return;
    reported = true;
    emitTransfer({
      direction: "outgoing",
      status,
      fileName: info?.fileName ?? (rawPath ? path.basename(rawPath) : "(bilinmeyen dosya)"),
      path: info?.displayPath ?? (rawPath || null),
      sizeBytes: info?.sizeBytes ?? null,
      deviceId: req.deviceId ?? null,
      ...(error ? { error } : {}),
    });
  };
  res.on("finish", () =>
    res.statusCode < 400 ? report("success") : report("failed", bodyError(res) ?? `HTTP ${res.statusCode}`)
  );
  res.on("close", () => {
    if (!res.writableFinished) report("failed", "Bağlantı yarıda koptu");
  });
}

/**
 * Yükleme BAŞARISIZLIKLARINI yakalar. Başarı olayları, dosya adı/boyutu
 * ancak orada bilindiği için route'un içinden açıkça yayınlanır.
 */
/**
 * Parçalı yüklemede aynı oturum için art arda gelen başarısızlıkların tek
 * kayda indirgenmesi. Aksi hâlde 50 parçalık bir dosya tekrar tekrar
 * başarısız olduğunda bildirim listesi aynı dosya için onlarca satırla
 * doluyordu.
 */
const recentChunkFailures = new Map<string, number>();
const CHUNK_FAILURE_DEDUPE_MS = 60_000;

function shouldReportChunkFailure(uploadId: string | undefined): boolean {
  if (!uploadId) return true;
  const now = Date.now();
  // Süresi dolmuş kayıtları temizle - Map sınırsız büyümesin.
  for (const [key, at] of recentChunkFailures) {
    if (now - at > CHUNK_FAILURE_DEDUPE_MS) recentChunkFailures.delete(key);
  }
  if (recentChunkFailures.has(uploadId)) return false;
  recentChunkFailures.set(uploadId, now);
  return true;
}

function watchUploadFailure(req: import("express").Request, res: import("express").Response): void {
  captureJsonBody(res);
  let reported = false;
  const report = (error: string) => {
    if (reported) return;
    // Başarı olayları zaten yayınlandıysa (res.json'dan hemen önce) bu
    // yanıtın koparılması aynı yüklemeyi ikinci kez, "başarısız" olarak
    // kaydederdi.
    if (res.locals.transferReported) return;
    const uploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId : undefined;
    if (res.locals.isChunkUpload && !shouldReportChunkFailure(uploadId)) return;
    reported = true;
    emitTransfer({
      direction: "incoming",
      status: "failed",
      fileName: (res.locals.uploadLabel as string | undefined) ?? "(yükleme)",
      path: null,
      sizeBytes: null,
      deviceId: req.deviceId ?? null,
      error,
    });
  };
  res.on("finish", () => {
    if (res.statusCode >= 400) report(bodyError(res) ?? `HTTP ${res.statusCode}`);
  });
  res.on("close", () => {
    if (!res.writableFinished) report("Bağlantı yarıda koptu");
  });
}

filesRouter.get("/", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  try {
    const result = await listDirectory(rawPath);
    res.json(result);
  } catch (err) {
    if (err instanceof PathOutsideStorageError) {
      res.status(400).json({ ok: false, error: err.message });
    } else if (err instanceof NotADirectoryError) {
      res.status(400).json({ ok: false, error: err.message });
    } else if (err instanceof DirectoryNotFoundError) {
      res.status(404).json({ ok: false, error: err.message });
    } else if (err instanceof StorageRootUnavailableError) {
      res.status(503).json({ ok: false, error: err.message });
    } else {
      throw err;
    }
  }
});

function streamAndHandleErrors(stream: ReturnType<typeof createReadStream>, res: import("express").Response) {
  pipeline(stream, res).catch(() => {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Dosya okunurken hata oluştu" });
    } else {
      res.destroy();
    }
  });
}

filesRouter.get("/download", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  watchDownloadOutcome(req, res, rawPath);
  if (rawPath.length === 0) {
    res.status(400).json({ ok: false, error: "path parametresi gerekli" });
    return;
  }

  let file: { absolutePath: string; size: number };
  try {
    file = await resolveExistingFile(rawPath);
  } catch (err) {
    if (err instanceof PathOutsideStorageError) {
      res.status(400).json({ ok: false, error: err.message });
    } else if (err instanceof NotAFileError) {
      res.status(400).json({ ok: false, error: err.message });
    } else if (err instanceof FileNotFoundError) {
      res.status(404).json({ ok: false, error: err.message });
    } else if (err instanceof StorageRootUnavailableError) {
      res.status(503).json({ ok: false, error: err.message });
    } else {
      throw err;
    }
    return;
  }

  const { absolutePath, size } = file;
  const fileName = path.basename(absolutePath);
  const rangeHeader = req.headers.range;

  if (!rangeHeader) {
    res.locals.downloadInfo = { fileName, displayPath: rawPath, sizeBytes: size } satisfies DownloadInfo;
    res.status(200);
    res.setHeader("Content-Type", getMimeType(fileName));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", size);
    streamAndHandleErrors(createReadStream(absolutePath), res);
    return;
  }

  if (rangeHeader.includes(",")) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.json({ ok: false, error: "Çoklu aralık (multi-range) desteklenmiyor" });
    return;
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    res.status(400).json({ ok: false, error: "Range başlığı geçersiz" });
    return;
  }

  const start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : size - 1;

  if (start >= size || start > end) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.json({ ok: false, error: "İstenen aralık dosya boyutunu aşıyor" });
    return;
  }

  if (end > size - 1) end = size - 1;

  // Yalnızca dosyanın SONUNA ulaşan menzil, indirmenin tamamlandığı anlamına
  // gelir — devam ettirilebilir indirmede tek bir kayıt oluşsun diye ara
  // parçalarda downloadInfo bilinçli olarak atanmıyor.
  if (end === size - 1) {
    res.locals.downloadInfo = { fileName, displayPath: rawPath, sizeBytes: size } satisfies DownloadInfo;
  }

  res.status(206);
  res.setHeader("Content-Type", getMimeType(fileName));
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", end - start + 1);
  streamAndHandleErrors(createReadStream(absolutePath, { start, end }), res);
});

filesRouter.post("/upload", (req, res) => {
  watchUploadFailure(req, res);
  uploadMiddleware(req, res, async (err) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length > 0) res.locals.uploadLabel = files.map((f) => f.originalname).join(", ");

    if (err) {
      await cleanupTempFiles(files);
      if (err instanceof StorageRootUnavailableError) {
        res.status(503).json({ ok: false, error: err.message });
      } else {
        res.status(400).json({ ok: false, error: "Yükleme isteği okunamadı" });
      }
      return;
    }

    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    const targetPathRaw = typeof req.body?.targetPath === "string" ? req.body.targetPath : "";
    const deviceId = req.deviceId ?? null;

    if (files.length === 0 && note.length === 0) {
      res.status(400).json({ ok: false, error: "Dosya ya da not gerekli" });
      return;
    }

    let targetDir: string;
    try {
      targetDir = await resolveExistingDirectory(targetPathRaw);
    } catch (dirErr) {
      await cleanupTempFiles(files);
      if (dirErr instanceof PathOutsideStorageError) {
        res.status(400).json({ ok: false, error: dirErr.message });
      } else if (dirErr instanceof DirectoryNotFoundError) {
        res.status(404).json({ ok: false, error: dirErr.message });
      } else if (dirErr instanceof NotADirectoryError) {
        res.status(400).json({ ok: false, error: dirErr.message });
      } else if (dirErr instanceof StorageRootUnavailableError) {
        res.status(503).json({ ok: false, error: dirErr.message });
      } else {
        throw dirErr;
      }
      return;
    }

    try {
      await fs.access(targetDir, fsConstants.W_OK);
    } catch {
      await cleanupTempFiles(files);
      console.error(`Depo klasörüne yazılamıyor (izin yok): ${targetDir}`);
      res.status(503).json({ ok: false, error: "Depo klasörüne yazılamıyor" });
      return;
    }

    const uploaded: { name: string; path: string; size: number }[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const committed: string[] = [];

    try {
      if (files.length === 0) {
        const { name: desiredName, path: finalPath } = await claimAvailableName(
          targetDir,
          buildNoteFileName(),
          (p) => fs.writeFile(p, note, { encoding: "utf-8", flag: "wx" })
        );
        committed.push(finalPath);
        await writeMetaFile(finalPath, { note, uploadedBy: deviceId, originalName: desiredName, isNoteOnly: true });
        committed.push(`${finalPath}.meta.json`);
        const stats = await fs.stat(finalPath);
        uploaded.push({ name: desiredName, path: toDisplayPath(finalPath), size: stats.size });
      } else {
        for (const file of files) {
          const sanitized = sanitizeFileName(file.originalname);
          if (isInvalidFileName(sanitized)) {
            skipped.push({ name: file.originalname, reason: "Geçersiz dosya adı" });
            await fs.unlink(file.path).catch(() => {});
            continue;
          }
          const { name: finalName, path: finalPath } = await claimAvailableName(
            targetDir,
            sanitized,
            (p) => fs.link(file.path, p)
          );
          await fs.unlink(file.path).catch(() => {});
          committed.push(finalPath);
          await writeMetaFile(finalPath, {
            note: note.length > 0 ? note : null,
            uploadedBy: deviceId,
            originalName: file.originalname,
          });
          committed.push(`${finalPath}.meta.json`);
          uploaded.push({ name: finalName, path: toDisplayPath(finalPath), size: file.size });
        }
      }
    } catch (writeErr) {
      await Promise.all(committed.map((p) => fs.unlink(p).catch(() => {})));
      await cleanupTempFiles(files);
      const code = (writeErr as NodeJS.ErrnoException).code;
      if (code === "ENAMETOOLONG" || code === "EINVAL") {
        res.status(400).json({ ok: false, error: "Dosya adı geçersiz veya çok uzun" });
      } else {
        console.error(`Depo klasörüne yazılamıyor: ${targetDir}`, writeErr);
        res.status(503).json({ ok: false, error: "Depo klasörüne yazılamıyor" });
      }
      return;
    }

    // Bir istek birden çok dosya taşıyabildiğinden her dosya için AYRI bir
    // olay yayınlanıyor - atlananlar (geçersiz ad vb.) da başarısız sayılır.
    for (const item of uploaded) {
      emitTransfer({
        direction: "incoming",
        status: "success",
        fileName: item.name,
        path: item.path,
        sizeBytes: item.size,
        deviceId,
      });
    }
    for (const item of skipped) {
      emitTransfer({
        direction: "incoming",
        status: "failed",
        fileName: item.name,
        path: null,
        sizeBytes: null,
        deviceId,
        error: item.reason,
      });
    }
    // Bu yükleme için sonuç zaten yazıldı; yanıt gönderilirken bağlantı
    // koparsa başarısızlık gözlemcisi ikinci bir kayıt oluşturmasın.
    res.locals.transferReported = true;

    res.json({ ok: true, uploaded, skipped });
  });
});

// Bir uploadId'ye dokunan HER ŞEY (parça yazma, sayma, birleştirme, silme)
// bu kuyruktan geçer — aynı uploadId için gelen istekler sıraya girer,
// asla eş zamanlı çalışmaz. Bu olmadan (yalnızca "birleştiriliyor" bayrağı
// gibi daha zayıf bir kontrolle) bir DELETE isteği tam da bir parça
// yazılırken ya da birleştirme sürerken araya girip oturum klasörünü
// silebiliyordu — bu da ya sessizce bozuk bir oturum (istemeden yeniden
// oluşturulmuş, eksik parçalı) ya da yakalanmamış bir hatadan 500 yanıtına
// yol açıyordu (elle eşzamanlı bir istekle doğrulandı).
const uploadLocks = new Map<string, Promise<void>>();

function withUploadLock<T>(uploadId: string, task: () => Promise<T>): Promise<T> {
  const previousTail = uploadLocks.get(uploadId) ?? Promise.resolve();
  const result = previousTail.then(task, task);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  uploadLocks.set(uploadId, tail);
  tail.then(() => {
    if (uploadLocks.get(uploadId) === tail) uploadLocks.delete(uploadId);
  });
  return result;
}

// DELETE'in, aktif bir birleştirmeyle karşılaştığında kuyrukta sessizce
// beklemek yerine hemen 409 ile anlamlı bir yanıt verebilmesi için. Gerçek
// güvenlik garantisi yukarıdaki uploadLocks'tan gelir; bu sadece daha iyi
// bir hata mesajı sağlamak için erken bir kontrol.
const mergingUploadIds = new Set<string>();

filesRouter.post("/upload/chunk", (req, res) => {
  // Başarılı parçalar (complete:false) 2xx döndüğünden olay yayınlamaz -
  // sadece bir parça isteği hata alırsa başarısız aktarım kaydı oluşur.
  res.locals.isChunkUpload = true;
  watchUploadFailure(req, res);
  chunkUploadMiddleware(req, res, async (err) => {
    const file = req.file as Express.Multer.File | undefined;
    if (typeof req.body?.fileName === "string") res.locals.uploadLabel = req.body.fileName;

    if (err) {
      if (file) await fs.unlink(file.path).catch(() => {});
      if (err instanceof StorageRootUnavailableError) {
        res.status(503).json({ ok: false, error: err.message });
      } else if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ ok: false, error: "Parça çok büyük" });
      } else {
        res.status(400).json({ ok: false, error: "Parça isteği okunamadı" });
      }
      return;
    }

    if (!file) {
      res.status(400).json({ ok: false, error: "chunk dosyası gerekli" });
      return;
    }

    const uploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId.trim() : "";
    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName : "";
    const targetPathRaw = typeof req.body?.targetPath === "string" ? req.body.targetPath : "";
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    const chunkIndex = Number(req.body?.chunkIndex);
    const totalChunks = Number(req.body?.totalChunks);
    const deviceId = req.deviceId ?? null;

    if (!UPLOAD_ID_PATTERN.test(uploadId)) {
      await fs.unlink(file.path).catch(() => {});
      res.status(400).json({ ok: false, error: "uploadId geçersiz" });
      return;
    }
    if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
      await fs.unlink(file.path).catch(() => {});
      res.status(400).json({ ok: false, error: "totalChunks geçersiz" });
      return;
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
      await fs.unlink(file.path).catch(() => {});
      res.status(400).json({ ok: false, error: "chunkIndex aralık dışında" });
      return;
    }

    await withUploadLock(uploadId, async () => {
      const sessionDir = path.join(config.storageRoot, TEMP_UPLOAD_DIR_NAME, uploadId);

      let session: ChunkSession | null;
      try {
        session = await readChunkSession(sessionDir);
      } catch (readErr) {
        await fs.unlink(file.path).catch(() => {});
        console.error(`Oturum dosyası okunamadı: ${sessionDir}`, readErr);
        res.status(503).json({ ok: false, error: "Depo klasörüne erişilemiyor" });
        return;
      }

      if (session === null) {
        if (!fileName) {
          await fs.unlink(file.path).catch(() => {});
          res.status(400).json({ ok: false, error: "fileName gerekli" });
          return;
        }

        try {
          await resolveExistingDirectory(targetPathRaw);
        } catch (dirErr) {
          await fs.unlink(file.path).catch(() => {});
          if (dirErr instanceof PathOutsideStorageError) {
            res.status(400).json({ ok: false, error: dirErr.message });
          } else if (dirErr instanceof DirectoryNotFoundError) {
            res.status(404).json({ ok: false, error: dirErr.message });
          } else if (dirErr instanceof NotADirectoryError) {
            res.status(400).json({ ok: false, error: dirErr.message });
          } else if (dirErr instanceof StorageRootUnavailableError) {
            res.status(503).json({ ok: false, error: dirErr.message });
          } else {
            throw dirErr;
          }
          return;
        }

        const newSession: ChunkSession = {
          targetPath: targetPathRaw,
          note: note.length > 0 ? note : null,
          deviceId,
          totalChunks,
          fileName,
          createdAt: new Date().toISOString(),
        };
        await fs.mkdir(sessionDir, { recursive: true });
        await writeChunkSession(sessionDir, newSession);
        session = newSession;
      } else if (session.totalChunks !== totalChunks) {
        await fs.unlink(file.path).catch(() => {});
        res.status(400).json({ ok: false, error: "totalChunks önceki parçalarla uyuşmuyor" });
        return;
      }

      const activeSession: ChunkSession = session;

      // Ayni chunkIndex tekrar gelirse fs.rename hedefi sessizce degistirir
      // (üzerine yazar) — idempotent, çift kayıt oluşturmaz.
      await fs.rename(file.path, path.join(sessionDir, chunkFileName(chunkIndex)));

      const partFiles = (await fs.readdir(sessionDir)).filter((name) => name.endsWith(".part"));
      const receivedChunks = partFiles.length;

      if (receivedChunks < activeSession.totalChunks) {
        res.json({ ok: true, receivedChunks, totalChunks: activeSession.totalChunks, complete: false });
        return;
      }

      mergingUploadIds.add(uploadId);
      try {
        let targetDir: string;
        try {
          targetDir = await resolveExistingDirectory(activeSession.targetPath);
        } catch (dirErr) {
          console.error(`Depo klasörüne yazılamıyor (birleştirme): ${sessionDir}`, dirErr);
          res.status(503).json({ ok: false, error: "Depo klasörüne yazılamıyor" });
          return;
        }

        const sanitized = sanitizeFileName(activeSession.fileName);
        if (isInvalidFileName(sanitized)) {
          res.status(400).json({ ok: false, error: "Dosya adı geçersiz" });
          return;
        }

        let finalPath = "";
        try {
          const claimed = await claimAvailableName(targetDir, sanitized, (p) =>
            mergeChunkFiles(sessionDir, activeSession.totalChunks, p)
          );
          finalPath = claimed.path;
          await writeMetaFile(finalPath, {
            note: activeSession.note,
            uploadedBy: activeSession.deviceId,
            originalName: activeSession.fileName,
          });

          await fs.rm(sessionDir, { recursive: true, force: true });

          const stats = await fs.stat(finalPath);
          emitTransfer({
            direction: "incoming",
            status: "success",
            fileName: claimed.name,
            path: toDisplayPath(finalPath),
            sizeBytes: stats.size,
            deviceId: activeSession.deviceId,
          });
          res.locals.transferReported = true;
          recentChunkFailures.delete(uploadId);
          res.json({
            ok: true,
            receivedChunks: activeSession.totalChunks,
            totalChunks: activeSession.totalChunks,
            complete: true,
            name: claimed.name,
            path: toDisplayPath(finalPath),
            size: stats.size,
          });
        } catch (mergeErr) {
          if (finalPath) await fs.unlink(finalPath).catch(() => {});
          console.error(`Parça birleştirme başarısız: ${sessionDir}`, mergeErr);
          res.status(503).json({ ok: false, error: "Depo klasörüne yazılamıyor" });
        }
      } finally {
        mergingUploadIds.delete(uploadId);
      }
    });
  });
});

filesRouter.get("/upload/status", async (req, res) => {
  const uploadId = typeof req.query.uploadId === "string" ? req.query.uploadId : "";
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    res.status(400).json({ ok: false, error: "uploadId geçersiz" });
    return;
  }

  try {
    await assertStorageRootAvailable();
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
    return;
  }

  const sessionDir = path.join(config.storageRoot, TEMP_UPLOAD_DIR_NAME, uploadId);
  const session = await readChunkSession(sessionDir);
  if (session === null) {
    res.status(404).json({ ok: false, error: "Yükleme oturumu bulunamadı" });
    return;
  }

  const receivedChunkIndexes = await listReceivedChunkIndexes(sessionDir);
  res.json({
    ok: true,
    uploadId,
    fileName: session.fileName,
    targetPath: session.targetPath,
    note: session.note,
    deviceId: session.deviceId,
    totalChunks: session.totalChunks,
    receivedChunkIndexes,
    createdAt: session.createdAt,
  });
});

filesRouter.get("/upload/pending", async (_req, res) => {
  try {
    await assertStorageRootAvailable();
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
    return;
  }

  const tempDir = path.join(config.storageRoot, TEMP_UPLOAD_DIR_NAME);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(tempDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.json({ ok: true, pending: [] });
      return;
    }
    throw err;
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory());
  const pendingWithNulls = await Promise.all(
    sessionDirs.map(async (dirent) => {
      const sessionDir = path.join(tempDir, dirent.name);
      const session = await readChunkSession(sessionDir).catch(() => null);
      if (session === null) return null;
      const receivedChunks = (await listReceivedChunkIndexes(sessionDir)).length;
      return {
        uploadId: dirent.name,
        fileName: session.fileName,
        targetPath: session.targetPath,
        note: session.note,
        deviceId: session.deviceId,
        totalChunks: session.totalChunks,
        receivedChunks,
        createdAt: session.createdAt,
      };
    })
  );

  res.json({ ok: true, pending: pendingWithNulls.filter((p) => p !== null) });
});

filesRouter.delete("/upload/:uploadId", async (req, res) => {
  const { uploadId } = req.params;
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    res.status(400).json({ ok: false, error: "uploadId geçersiz" });
    return;
  }

  try {
    await assertStorageRootAvailable();
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
    return;
  }

  // Aktif bir birleştirme sürüyorsa, kuyrukta sessizce beklemek yerine
  // hemen anlamlı bir 409 dönüyoruz. Bu sadece erken/iyimser bir kontrol —
  // asıl güvenlik garantisi aşağıdaki withUploadLock'tan gelir, bu yüzden
  // check ile kilide giriş arasında kısa bir pencerede birleştirme
  // başlasa bile veri bozulmaz (delete, kuyrukta birleştirmeden sonraya
  // sıralanır ve session zaten silinmiş olacağından 404 döner).
  if (mergingUploadIds.has(uploadId)) {
    res.status(409).json({ ok: false, error: "Yükleme şu anda birleştiriliyor, birazdan tekrar deneyin" });
    return;
  }

  await withUploadLock(uploadId, async () => {
    const sessionDir = path.join(config.storageRoot, TEMP_UPLOAD_DIR_NAME, uploadId);
    let session: ChunkSession | null;
    try {
      session = await readChunkSession(sessionDir);
    } catch (err) {
      console.error(`Oturum silinemedi: ${sessionDir}`, err);
      res.status(503).json({ ok: false, error: "Depo klasörüne erişilemiyor" });
      return;
    }
    if (session === null) {
      res.status(404).json({ ok: false, error: "Yükleme oturumu bulunamadı" });
      return;
    }

    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
      res.status(204).end();
    } catch (rmErr) {
      console.error(`Oturum klasörü silinemedi: ${sessionDir}`, rmErr);
      res.status(503).json({ ok: false, error: "Depo klasöründen silinemiyor" });
    }
  });
});
