import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type TokenRecord = {
  tokenHash: string;
  createdAt: string;
};

type TokenStore = Record<string, TokenRecord>;

// Depo klasörünün (STORAGE_ROOT) dışında, proje kökünde ayrı bir dosya —
// kullanıcıya açık dosya alanıyla karışmasın diye. TOKENS_FILE env
// değişkeniyle ezilebilir (testlerin gerçek dosyaya dokunmadan, kendi
// geçici sunucu süreçlerini bu dosyayı işaret ederek başlatabilmesi için —
// STORAGE_ROOT ile aynı desen).
export const DEFAULT_TOKENS_FILE = process.env.TOKENS_FILE ?? path.join(__dirname, "..", "tokens.json");

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

async function readStore(filePath: string): Promise<TokenStore> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as TokenStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(filePath: string, store: TokenStore): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
}

// Cihaz için yeni, rastgele bir token üretir ve yalnızca hash'ini diske
// yazar; aynı cihaz için önceden bir token varsa üzerine yazılır (eskisi
// geçersiz olur). Dönen düz metin token, bu çağrının dışında hiçbir yerde
// saklanmaz — çağıran taraf onu cihaza iletmekle sorumludur.
export async function generateToken(
  deviceId: string,
  tokensFilePath: string = DEFAULT_TOKENS_FILE
): Promise<string> {
  if (!deviceId) throw new Error("deviceId gerekli");

  const token = randomBytes(32).toString("hex");
  const store = await readStore(tokensFilePath);
  store[deviceId] = { tokenHash: hashToken(token), createdAt: new Date().toISOString() };
  await writeStore(tokensFilePath, store);

  return token;
}

// Bir cihazın token'ını kalıcı olarak iptal eder (tokens.json'dan kaydı
// siler) — cihaz çıkarma akışının bir parçası. Kayıt yoksa false döner
// (çağıran taraf bunu "zaten yok" olarak ele alabilir), var olup silindiyse
// true döner.
export async function revokeToken(
  deviceId: string,
  tokensFilePath: string = DEFAULT_TOKENS_FILE
): Promise<boolean> {
  const store = await readStore(tokensFilePath);
  if (!(deviceId in store)) return false;

  delete store[deviceId];
  await writeStore(tokensFilePath, store);
  return true;
}

// Verilen token'in, verilen cihaz için kayıtlı token ile eşleşip
// eşleşmediğini kontrol eder. Zamanlama yan-kanalı saldırılarına karşı
// sabit zamanlı karşılaştırma kullanır.
export async function verifyToken(
  deviceId: string,
  token: string,
  tokensFilePath: string = DEFAULT_TOKENS_FILE
): Promise<boolean> {
  if (!deviceId || !token) return false;

  const store = await readStore(tokensFilePath);
  const record = store[deviceId];
  if (!record) return false;

  const expected = Buffer.from(record.tokenHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}
