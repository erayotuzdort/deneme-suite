import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import multer from "multer";
import { config } from "./config";
import { assertStorageRootAvailable } from "./files";

export const TEMP_UPLOAD_DIR_NAME = ".tmp-uploads";

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    (async () => {
      await assertStorageRootAvailable();
      const tempDir = path.join(config.storageRoot, TEMP_UPLOAD_DIR_NAME);
      await fs.mkdir(tempDir, { recursive: true });
      return tempDir;
    })().then(
      (tempDir) => cb(null, tempDir),
      (err) => cb(err, "")
    );
  },
  filename: (_req, _file, cb) => {
    cb(null, randomUUID());
  },
});

export const uploadMiddleware = multer({ storage }).array("files");

// Parca (chunk) yuklemede tek dosya alani ("chunk") kullanilir; boyut siniri
// ~2 MB'lik bir parca + multipart govde ek yukunu (Content-Disposition,
// boundary vb.) karsilamak icin ~3 MB birakilir.
export const chunkUploadMiddleware = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
}).single("chunk");

// uploadId istemciden gelir ve dogrudan bir klasor adi olarak kullanilir;
// path traversal'a (ör. "../../evil") acilmamasi icin sadece guvenli
// karakterlere izin veriyoruz.
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function chunkFileName(chunkIndex: number): string {
  return `${String(chunkIndex).padStart(4, "0")}.part`;
}

const SESSION_FILE_NAME = ".session.json";

export type ChunkSession = {
  targetPath: string;
  note: string | null;
  deviceId: string | null;
  totalChunks: number;
  fileName: string;
  createdAt: string;
};

export async function readChunkSession(sessionDir: string): Promise<ChunkSession | null> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, SESSION_FILE_NAME), "utf-8");
    return JSON.parse(raw) as ChunkSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeChunkSession(sessionDir: string, session: ChunkSession): Promise<void> {
  await fs.writeFile(path.join(sessionDir, SESSION_FILE_NAME), JSON.stringify(session, null, 2), "utf-8");
}

// sessionDir icindeki ".part" dosyalarindan, hangi chunkIndex'lerin
// alindigini kucukten buyuge sirali bir dizi olarak cikarir (ör. [0,1,3]) —
// istemci bunu kullanip hangi parcalarin eksik oldugunu hesaplayabilir.
export async function listReceivedChunkIndexes(sessionDir: string): Promise<number[]> {
  const entries = await fs.readdir(sessionDir);
  return entries
    .filter((name) => name.endsWith(".part"))
    .map((name) => Number.parseInt(name.slice(0, -".part".length), 10))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

// claimAvailableName'in "create" parametresiyle uyumlu: hedef yolu ozel
// (wx) acar, boylece iki eszamanli birlestirme denemesinden en fazla biri
// basarili olur (digeri EEXIST alip claimAvailableName'in kendi "bir
// sonraki adi dene" mantigina duser). Parcalari 0'dan totalChunks-1'e
// kadar sirayla okuyup ayni dosyaya ekler.
export async function mergeChunkFiles(
  sessionDir: string,
  totalChunks: number,
  finalPath: string
): Promise<void> {
  const handle = await fs.open(finalPath, "wx");
  try {
    for (let i = 0; i < totalChunks; i++) {
      const data = await fs.readFile(path.join(sessionDir, chunkFileName(i)));
      await handle.write(data);
    }
  } finally {
    await handle.close();
  }
}

// busboy, Content-Disposition icindeki dosya adini varsayilan olarak latin1 olarak
// coder; cogu gercek istemci (tarayici, React Native fetch/FormData) adi ham UTF-8
// bayt olarak gonderdigi icin ASCII-disi adlar bozuluyor (orn. "türkçe.txt" ->
// "tÃ¼rkÃ§e.txt"). Bunu latin1->utf8 olarak yeniden kodlayip, sonuc gecerliyse
// (U+FFFD icermiyorsa) kullaniyoruz; zaten dogru kodlanmis bir ad bu donusumden
// gecerse bozulacagindan, sadece iyilesme saglayan durumlarda uyguluyoruz.
export function fixFileNameEncoding(name: string): string {
  try {
    const reencoded = Buffer.from(name, "latin1").toString("utf8");
    if (!reencoded.includes("�") && reencoded !== name) {
      return reencoded;
    }
  } catch {
    // yeniden kodlama basarisiz olursa orijinal adi kullan
  }
  return name;
}

const WINDOWS_FORBIDDEN_CHARS = /\.\.|[<>:"/\\|?*\x00-\x1F]/g;
const MAX_FILENAME_LENGTH = 255; // NTFS'te tek bir dosya adi bileseninin sert siniri

export function sanitizeFileName(originalName: string): string {
  const base = path.basename(fixFileNameEncoding(originalName));
  // NTFS Unicode'u normallestirmez: gorunuste ayni olan ama farkli kod
  // noktalariyla kodlanmis iki ad (NFC/NFD) sessizce iki ayri, birbirinden
  // ayirt edilemeyen dosya olarak var olabilir. NFC'ye sabitleyerek bu
  // durumu, mevcut "ayni ad -> (1), (2), ..." numaralandirma mekanizmasina
  // dahil ediyoruz.
  const normalized = base.normalize("NFC");
  return normalized.replace(WINDOWS_FORBIDDEN_CHARS, "_");
}

export function isInvalidFileName(name: string): boolean {
  if (name.length === 0) return true;
  if (name.length > MAX_FILENAME_LENGTH) return true;
  if (name.startsWith(".") && !name.slice(1).includes(".")) return true;
  return false;
}

// Ayni ada sahip iki yukleme ayni anda gelirse (getAvailableFileName ile "var mi
// kontrol et, sonra yaz" seklinde bir yontem) araya baska bir istek girip veri
// kaybina yol acabilir. Bunun yerine, isim adaylarini dosya sistemine ait "wx"/
// hard-link exclusive-create garantisiyle deneyip EEXIST'te bir sonrakine geciyoruz;
// bu sekilde ad tahsisi atomikleşiyor.
export async function claimAvailableName(
  dir: string,
  desiredName: string,
  create: (finalPath: string) => Promise<void>
): Promise<{ name: string; path: string }> {
  const ext = path.extname(desiredName);
  const base = ext ? desiredName.slice(0, -ext.length) : desiredName;
  const MAX_ATTEMPTS = 1000;

  let candidate = desiredName;
  for (let attempt = 0, counter = 1; attempt < MAX_ATTEMPTS; attempt++) {
    const finalPath = path.join(dir, candidate);
    try {
      await create(finalPath);
      return { name: candidate, path: finalPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        candidate = `${base} (${counter})${ext}`;
        counter++;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Uygun dosya adı bulunamadı");
}

export type UploadMeta = {
  note: string | null;
  uploadedBy: string | null;
  originalName: string;
  /** true ise bu dosya, kullanıcı SADECE bir not gönderdiğinde otomatik
   * oluşturulan bir "mesaj" dosyasıdır (bkz. buildNoteFileName) - normal bir
   * dosya yüklemesi değil. src/messages.ts bu alanı kullanarak /api/messages
   * listesini filtreliyor. Normal dosya yüklemelerinde YAZILMIYOR (undefined
   * kalıyor) - mevcut .meta.json şeklini gereksiz yere şişirmemek için. */
  isNoteOnly?: boolean;
};

export async function writeMetaFile(finalPath: string, meta: UploadMeta): Promise<void> {
  const content = {
    note: meta.note,
    uploadedBy: meta.uploadedBy,
    uploadedAt: new Date().toISOString(),
    originalName: meta.originalName,
    ...(meta.isNoteOnly ? { isNoteOnly: true } : {}),
  };
  await fs.writeFile(`${finalPath}.meta.json`, JSON.stringify(content, null, 2), "utf-8");
}

export function buildNoteFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `not-${stamp}.txt`;
}

export async function cleanupTempFiles(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
}

// Sunucu bir yukleme sirasinda beklenmedik sekilde kapanirsa (cokme, guc kesintisi
// vb.), o an surmekte olan yuklemenin gecici dosyasi .tmp-uploads altinda kalici
// olarak kalabilir (kimse temizlemez). Bu yuzden acilista bir kerelik temizlik
// yapiyoruz; temizlik basarisiz olsa bile sunucu acilmaya devam etmeli.
//
// fs.unlink DEGIL fs.rm: .tmp-uploads altinda iki farkli sekil var — duz
// multipart gecici DOSYALARI ve parcali yukleme oturumlarinin KLASORLERI
// (bkz. routes/files.ts, fs.mkdir(sessionDir)). unlink bir klasorde calismaz
// (Windows'ta EPERM) ve hata yutuldugu icin yarim kalan her parcali yukleme,
// icindeki tum .part verisiyle birlikte depoda kalici olarak kaliyordu —
// 4 GB'lik bir dosyanin %90'inda kesilen bir yukleme ~3,6 GB'i sonsuza kadar
// tutuyordu. rm(recursive) ikisini de kaldirir.
export async function cleanupOrphanedTempUploads(): Promise<number> {
  const tempDir = path.join(config.storageRoot, TEMP_UPLOAD_DIR_NAME);
  let entries: string[];
  try {
    entries = await fs.readdir(tempDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let deleted = 0;
  await Promise.all(
    entries.map(async (name) => {
      try {
        await fs.rm(path.join(tempDir, name), { recursive: true, force: true });
        deleted++;
      } catch {
        // tek bir girdi silinemezse digerlerini engellemesin
      }
    })
  );
  return deleted;
}

// Depo kullanicinin normal bir klasoru; bir dosya Gezgin'den silindiginde
// yanindaki "<ad>.meta.json" geride kaliyor ve hicbir sey onu toplamiyor
// (listeleme onlari zaten gizliyor, dolayisiyla kullanici da goremiyor).
// Acilista bir kez, ESI OLMAYAN meta dosyalarini temizliyoruz.
//
// Bilerek dar: yalnizca tam olarak "<mevcut olmayan dosya>.meta.json"
// desenine uyanlar siliniyor. NFC karsilastirmasi sanitizeFileName ile ayni
// nedenle yapiliyor — NTFS normallestirme yapmadigindan, NFD kodlanmis bir
// dosya adi NFC kodlanmis meta esini "yok" sanip yanlislikla silmemeli.
export async function cleanupOrphanedMetaFiles(dir: string = config.storageRoot): Promise<number> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const present = new Set(dirents.filter((d) => !d.isDirectory()).map((d) => d.name.normalize("NFC")));
  let deleted = 0;

  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      deleted += await cleanupOrphanedMetaFiles(full);
      continue;
    }
    if (!dirent.name.endsWith(".meta.json")) continue;
    const owner = dirent.name.slice(0, -".meta.json".length).normalize("NFC");
    if (owner.length === 0 || present.has(owner)) continue;
    try {
      await fs.unlink(full);
      deleted++;
    } catch {
      // silinemezse digerlerini engellemesin
    }
  }
  return deleted;
}
