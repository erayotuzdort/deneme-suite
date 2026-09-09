// Bu dosyadaki tüm istek yardımcıları, requireAuth eklendikten sonra
// mevcut testlerin tek tek her çağrı noktasında auth header'ı taşımak
// zorunda kalmaması için bir "varsayılan header" mekanizması kullanır.
// Her test dosyası kendi before() kancasında setDefaultHeaders(server.authHeaders)
// çağırır; node:test her dosyayı ayrı bir süreçte çalıştırdığından bu
// modül-düzeyi durum dosyalar arasında sızmaz. Bir çağrıda kasıtlı olarak
// HİÇBİR header (varsayılanlar dahil) gönderilmemesi gerekiyorsa (ör.
// "auth yokken 401" testleri) `headers` parametresine açıkça `null` verilir.
let defaultHeaders: Record<string, string> = {};

export function setDefaultHeaders(headers: Record<string, string>): void {
  defaultHeaders = headers;
}

function mergeHeaders(headers?: Record<string, string> | null): Record<string, string> | undefined {
  if (headers === null) return undefined;
  return { ...defaultHeaders, ...(headers ?? {}) };
}

export type JsonResult = { status: number; body: any; headers: Headers };

export async function getJson(url: string, headers?: Record<string, string> | null): Promise<JsonResult> {
  const res = await fetch(url, { headers: mergeHeaders(headers) });
  const text = await res.text();
  let body: any;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

export async function deleteRequest(url: string, headers?: Record<string, string> | null): Promise<JsonResult> {
  const res = await fetch(url, { method: "DELETE", headers: mergeHeaders(headers) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

export type RawResult = { status: number; text: string; headers: Headers };

export async function getRaw(
  url: string,
  headers?: Record<string, string> | null
): Promise<RawResult> {
  const res = await fetch(url, { headers: mergeHeaders(headers) });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

export type UploadFile = {
  fieldName?: string;
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

// Cogu senaryo icin: native FormData/Blob kullanarak normal (RFC'ye uygun) bir
// multipart istegi kurar. Busboy/multer'in gercek dunya istemcileriyle nasil
// davrandigini test eder.
export async function uploadMultipart(
  baseUrl: string,
  opts: {
    files?: UploadFile[];
    fields?: Record<string, string>;
    headers?: Record<string, string> | null;
  }
): Promise<JsonResult> {
  const form = new FormData();
  for (const f of opts.files ?? []) {
    const buf = typeof f.content === "string" ? Buffer.from(f.content) : f.content;
    const blob = new Blob([new Uint8Array(buf)], { type: f.contentType ?? "application/octet-stream" });
    form.append(f.fieldName ?? "files", blob, f.filename);
  }
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);

  const res = await fetch(`${baseUrl}/api/files/upload`, {
    method: "POST",
    body: form,
    headers: mergeHeaders(opts.headers),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

// Content-Disposition uzerinde tam kontrol gereken kenar durumlari (bos dosya adi,
// CRLF/kontrol karakteri enjeksiyonu, cift tirnak) icin multipart govdesini
// elle, bayt duzeyinde kuran yardimci. Native FormData bu degerleri reddedebilir
// ya da kendi kurallarina gore kacislayabilir; bu yuzden burada tam kontrol
// gerekiyor.
export async function uploadRawMultipart(
  baseUrl: string,
  opts: {
    filenameRaw: string; // header'a OLDUĞU GİBİ yazılır, kaçışlanmaz
    content: Buffer | string;
    note?: string;
    targetPath?: string;
    headers?: Record<string, string> | null;
  }
): Promise<JsonResult> {
  const boundary = "----NodeTestBoundary" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  const push = (s: string) => parts.push(Buffer.from(s, "utf8"));

  // Content-Disposition tirnakli-dize kurallarina gore, deger icindeki ters
  // egik cizgi ve cift tirnak kacislanmalidir (RFC 6266) — aksi halde header'in
  // kendisi bozulur ve test, sunucu degil kendi hatasini olcer. Gercek istemciler
  // bunu otomatik yapar; burada elle yapiyoruz.
  const escapedFilename = opts.filenameRaw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="files"; filename="${escapedFilename}"\r\n`);
  push(`Content-Type: application/octet-stream\r\n\r\n`);
  parts.push(typeof opts.content === "string" ? Buffer.from(opts.content, "utf8") : opts.content);
  push(`\r\n`);

  if (opts.note !== undefined) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="note"\r\n\r\n`);
    push(`${opts.note}\r\n`);
  }

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="targetPath"\r\n\r\n`);
  push(`${opts.targetPath ?? ""}\r\n`);
  push(`--${boundary}--\r\n`);

  const bodyBuf = Buffer.concat(parts);
  const res = await fetch(`${baseUrl}/api/files/upload`, {
    method: "POST",
    body: bodyBuf,
    headers: { ...mergeHeaders(opts.headers), "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  const text = await res.text();
  let body: any;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

// POST /api/files/upload/chunk icin: tek "chunk" dosya alani + oturum
// alanlari (uploadId, chunkIndex, totalChunks, fileName, targetPath, note).
export async function uploadChunk(
  baseUrl: string,
  opts: {
    content: Buffer | string;
    fields: {
      uploadId: string;
      chunkIndex: number | string;
      totalChunks: number | string;
      fileName?: string;
      targetPath?: string;
      note?: string;
    };
    headers?: Record<string, string> | null;
  }
): Promise<JsonResult> {
  const form = new FormData();
  const buf = typeof opts.content === "string" ? Buffer.from(opts.content) : opts.content;
  const blob = new Blob([new Uint8Array(buf)], { type: "application/octet-stream" });
  form.append("chunk", blob, "chunk.part");
  form.append("uploadId", opts.fields.uploadId);
  form.append("chunkIndex", String(opts.fields.chunkIndex));
  form.append("totalChunks", String(opts.fields.totalChunks));
  if (opts.fields.fileName !== undefined) form.append("fileName", opts.fields.fileName);
  if (opts.fields.targetPath !== undefined) form.append("targetPath", opts.fields.targetPath);
  if (opts.fields.note !== undefined) form.append("note", opts.fields.note);

  const res = await fetch(`${baseUrl}/api/files/upload/chunk`, {
    method: "POST",
    body: form,
    headers: mergeHeaders(opts.headers),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
