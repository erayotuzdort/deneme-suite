import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";

export class FileNotFoundError extends Error {
  constructor() {
    super("Dosya bulunamadı");
    this.name = "FileNotFoundError";
  }
}

export class NotAFileError extends Error {
  constructor() {
    super("İstenen yol bir dosya değil");
    this.name = "NotAFileError";
  }
}

export class PathOutsideStorageError extends Error {
  constructor() {
    super("Yol depo kökünün dışına çıkıyor");
    this.name = "PathOutsideStorageError";
  }
}

export class DirectoryNotFoundError extends Error {
  constructor() {
    super("Klasör bulunamadı");
    this.name = "DirectoryNotFoundError";
  }
}

export class NotADirectoryError extends Error {
  constructor() {
    super("İstenen yol bir klasör değil");
    this.name = "NotADirectoryError";
  }
}

export class StorageRootUnavailableError extends Error {
  constructor() {
    super("Depo klasörüne erişilemiyor");
    this.name = "StorageRootUnavailableError";
  }
}

const EXTENSION_CATEGORIES: Record<string, "image" | "video" | "audio" | "document" | "archive"> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  heic: "image",
  mp4: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  ogg: "audio",
  m4a: "audio",
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  txt: "document",
  md: "document",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
};

function getFileType(name: string): "image" | "video" | "audio" | "document" | "archive" | "other" {
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXTENSION_CATEGORIES[ext] ?? "other";
}

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
};

export function getMimeType(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function toDisplayPath(absolutePath: string): string {
  const rel = path.relative(config.storageRoot, absolutePath);
  if (rel === "") return "/";
  return "/" + rel.split(path.sep).join("/");
}

/**
 * NTFS alternatif veri akışı (ADS) ayracı. "klasor::$INDEX_ALLOCATION" ya da
 * "dosya.txt:gizli" gibi bir yol, Windows tarafından AYNI nesneye çözülür ve
 * path.relative/realpath kontrollerinden geçerdi — depo dışına çıkış değil,
 * ama aynı klasörün sonsuz sayıda takma adı demek: dönen her girdinin `path`
 * alanı bu sonekle zehirleniyor ve istemci tarafındaki her eşitlik/önbellek
 * karşılaştırması bozuluyor. Yüklemede ":" zaten WINDOWS_FORBIDDEN_CHARS ile
 * "_" yapıldığından, meşru hiçbir dosya adı iki nokta içermez.
 */
const ADS_SEPARATOR = /:/;

function resolveWithinStorage(relativePath: string): string {
  const normalized = relativePath.replace(/^[/\\]+/, "");
  if (ADS_SEPARATOR.test(normalized)) {
    throw new PathOutsideStorageError();
  }
  const target = path.resolve(config.storageRoot, normalized);
  const rel = path.relative(config.storageRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathOutsideStorageError();
  }
  return target;
}

export async function assertStorageRootAvailable(): Promise<void> {
  try {
    const stats = await fs.stat(config.storageRoot);
    if (!stats.isDirectory()) throw new Error();
  } catch {
    console.error(`Depo klasörüne erişilemiyor: ${config.storageRoot}`);
    throw new StorageRootUnavailableError();
  }
}

async function assertRealPathWithinStorage(absolutePath: string): Promise<void> {
  const [real, storageReal] = await Promise.all([
    fs.realpath(absolutePath),
    fs.realpath(config.storageRoot),
  ]);
  const rel = path.relative(storageReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathOutsideStorageError();
  }
}

export type DirectoryEntry = {
  name: string;
  path: string;
  kind: "folder" | "file";
  size: number | null;
  modifiedAt: string;
  fileType: "image" | "video" | "audio" | "document" | "archive" | "other" | null;
};

export async function resolveExistingFile(
  relativePath: string
): Promise<{ absolutePath: string; size: number }> {
  await assertStorageRootAvailable();
  const absolutePath = resolveWithinStorage(relativePath);

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileNotFoundError();
    throw err;
  }
  await assertRealPathWithinStorage(absolutePath);

  if (stats.isDirectory()) throw new NotAFileError();
  return { absolutePath, size: stats.size };
}

export async function resolveExistingDirectory(relativePath: string): Promise<string> {
  await assertStorageRootAvailable();
  const absolutePath = resolveWithinStorage(relativePath);

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new DirectoryNotFoundError();
    throw err;
  }
  await assertRealPathWithinStorage(absolutePath);

  if (!stats.isDirectory()) throw new NotADirectoryError();
  return absolutePath;
}

export async function listDirectory(
  relativePath: string
): Promise<{ path: string; entries: DirectoryEntry[] }> {
  await assertStorageRootAvailable();
  const dir = resolveWithinStorage(relativePath);

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new DirectoryNotFoundError();
    if (code === "ENOTDIR") throw new NotADirectoryError();
    throw err;
  }
  await assertRealPathWithinStorage(dir);

  const visible = dirents.filter(
    (d) => !d.name.startsWith(".") && !d.name.endsWith(".meta.json")
  );

  const entries = await Promise.all(
    visible.map(async (dirent): Promise<DirectoryEntry> => {
      const fullPath = path.join(dir, dirent.name);
      const stats = await fs.stat(fullPath);
      const entryPath = toDisplayPath(fullPath);
      if (dirent.isDirectory()) {
        return {
          name: dirent.name,
          path: entryPath,
          kind: "folder",
          size: null,
          modifiedAt: stats.mtime.toISOString(),
          fileType: null,
        };
      }
      return {
        name: dirent.name,
        path: entryPath,
        kind: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        fileType: getFileType(dirent.name),
      };
    })
  );

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, "tr");
  });

  return { path: toDisplayPath(dir), entries };
}
