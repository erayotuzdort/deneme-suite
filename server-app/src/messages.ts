import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import { toDisplayPath, resolveExistingFile, assertStorageRootAvailable } from "./files";

export type MessageSummary = {
  /** Görüntülenebilir yol (ör. "/not-2026-09-03T12-00-00-000Z.txt") - DELETE /api/messages/:id'de id olarak kullanılır. */
  id: string;
  fileName: string;
  note: string;
  uploadedBy: string | null;
  uploadedAt: string;
};

type NoteOnlyMeta = { note: string | null; uploadedBy: string | null; uploadedAt: string; isNoteOnly?: boolean };

// buildNoteFileName() (upload.ts) ile üretilen adların şekli - gereksiz
// .meta.json okumasından kaçınmak için hızlı bir ön filtre (asıl doğrulama
// isNoteOnly:true meta alanıyla yapılıyor, bu sadece bir performans
// optimizasyonu, güvenlik/doğruluk buna dayanmıyor).
const NOTE_FILE_PATTERN = /^not-.*\.txt$/;

async function readNoteOnlyMeta(filePath: string): Promise<NoteOnlyMeta | null> {
  try {
    const raw = await fs.readFile(`${filePath}.meta.json`, "utf-8");
    const meta = JSON.parse(raw) as NoteOnlyMeta;
    return meta.isNoteOnly ? meta : null;
  } catch {
    return null;
  }
}

async function walk(dir: string): Promise<MessageSummary[]> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: MessageSummary[] = [];
  for (const dirent of dirents) {
    // .tmp-uploads (geçici parça yükleme klasörü) ve diğer gizli girdiler dahil değil.
    if (dirent.name.startsWith(".")) continue;

    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      results.push(...(await walk(fullPath)));
      continue;
    }
    if (dirent.name.endsWith(".meta.json") || !NOTE_FILE_PATTERN.test(dirent.name)) continue;

    const meta = await readNoteOnlyMeta(fullPath);
    if (!meta) continue;
    results.push({
      id: toDisplayPath(fullPath),
      fileName: dirent.name,
      note: meta.note ?? "",
      uploadedBy: meta.uploadedBy,
      uploadedAt: meta.uploadedAt,
    });
  }
  return results;
}

/**
 * Depo ağacındaki TÜM not-only ("sadece not" olarak gönderilmiş) mesajları,
 * en yeniden eskiye sıralı döner.
 *
 * assertStorageRootAvailable ŞART: walk() readdir hatasını yutup [] döndüğü
 * için, depo klasörü silindiğinde/disk çıkarıldığında bu uç sessizce
 * "hiç mesaj yok" diyordu — diğer tüm uçlar aynı durumda 503 verirken.
 * Kullanıcı mesajlarının silindiğini sanıyordu.
 */
export async function listMessages(): Promise<MessageSummary[]> {
  await assertStorageRootAvailable();
  const results = await walk(config.storageRoot);
  results.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return results;
}

/**
 * Bir mesajı (not-only dosya + .meta.json'ı) siler. Bilerek DAR kapsamlı:
 * sadece isNoteOnly:true meta'ya sahip dosyaları siler - genel amaçlı bir
 * "id ile herhangi bir dosyayı sil" endpoint'i olmasın diye. displayPath
 * depo dışındaysa/dosya yoksa/not-only değilse false döner (silme
 * gerçekleşmez), aksi halde true.
 */
export async function deleteMessage(displayPath: string): Promise<boolean> {
  let absolutePath: string;
  try {
    const resolved = await resolveExistingFile(displayPath);
    absolutePath = resolved.absolutePath;
  } catch {
    return false;
  }

  const meta = await readNoteOnlyMeta(absolutePath);
  if (!meta) return false;

  await fs.unlink(absolutePath);
  await fs.unlink(`${absolutePath}.meta.json`).catch(() => {});
  return true;
}
