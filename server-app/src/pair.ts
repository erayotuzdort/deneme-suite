import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { generateToken, revokeToken } from "./auth";
import { getLastSeen } from "./lastSeen";

export type DeviceRecord = {
  name: string;
  pairedAt: string;
};

type DeviceStore = Record<string, DeviceRecord>;

// tokens.json gibi, STORAGE_ROOT dışında, proje kökünde ayrı bir dosya.
// Hassas veri içermez (sadece isim + eşleştirme zamanı), yalnızca referans
// amaçlıdır — gerçek yetkilendirme tokens.json'daki hash üzerinden yapılır.
// DEVICES_FILE env değişkeniyle ezilebilir (tokens.json'daki TOKENS_FILE ile
// aynı desen) — testlerin gerçek dosyaya dokunmadan izole çalışabilmesi için.
export const DEFAULT_DEVICES_FILE = process.env.DEVICES_FILE ?? path.join(__dirname, "..", "devices.json");

async function readDevicesStore(filePath: string): Promise<DeviceStore> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as DeviceStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeDevicesStore(filePath: string, store: DeviceStore): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
}

export type PairResult = {
  deviceId: string;
  name: string;
  token: string;
  pairedAt: string;
};

// Yeni bir cihaz için kimlik + token üretir (auth.ts'teki generateToken
// üzerinden — hash'i tokens.json'a yazan mevcut mantık aynen kullanılır),
// ardından cihazı devices.json'a kaydeder. Dönen düz metin token, sadece
// bu çağrının sonucunda görünür; çağıran taraf (CLI) onu ekranda
// göstermekten sorumludur.
export async function pairDevice(
  name: string,
  options?: { tokensFilePath?: string; devicesFilePath?: string }
): Promise<PairResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Cihaz adı gerekli");

  const deviceId = randomUUID();
  const token = await generateToken(deviceId, options?.tokensFilePath);
  const pairedAt = new Date().toISOString();

  const devicesFilePath = options?.devicesFilePath ?? DEFAULT_DEVICES_FILE;
  const devices = await readDevicesStore(devicesFilePath);
  devices[deviceId] = { name: trimmed, pairedAt };
  await writeDevicesStore(devicesFilePath, devices);

  return { deviceId, name: trimmed, token, pairedAt };
}

/** Eşleştirilmiş tüm cihazları (deviceId -> {name, pairedAt}) döner. */
export async function listDevices(devicesFilePath: string = DEFAULT_DEVICES_FILE): Promise<DeviceStore> {
  return readDevicesStore(devicesFilePath);
}

export type DeviceSummary = {
  deviceId: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  connected: boolean;
};

/** Bu süre içinde istek attıysa cihaz "bağlı" sayılır. */
const CONNECTED_WINDOW_MS = 2 * 60 * 1000;

/**
 * listDevices() + lastSeen'i birleştirip mobil/masaüstü istemcilerin
 * doğrudan kullanabileceği zenginleştirilmiş listeyi döner. routes/devices.ts
 * (HTTP) VE deneme-desktop'ın Sunucu paneli (doğrudan çağrı) aynı fonksiyonu
 * kullanır — "bağlı" hesaplaması iki yerde ayrı ayrı tanımlanmasın diye.
 */
export async function listDevicesWithStatus(devicesFilePath: string = DEFAULT_DEVICES_FILE): Promise<DeviceSummary[]> {
  const devices = await listDevices(devicesFilePath);
  return Object.entries(devices).map(([deviceId, record]) => {
    const seen = getLastSeen(deviceId);
    const connected = seen !== null && Date.now() - seen.getTime() < CONNECTED_WINDOW_MS;
    return {
      deviceId,
      name: record.name,
      pairedAt: record.pairedAt,
      lastSeenAt: seen ? seen.toISOString() : null,
      connected,
    };
  });
}

// Cihaz çıkarma akışının bir parçası: devices.json'dan kaydı siler. Kayıt
// yoksa false döner (çağıran taraf 404 üretebilir), var olup silindiyse
// true döner. Token iptali (tokens.json) ayrı bir çağrı gerektirir —
// bkz. auth.ts'teki revokeToken; iki dosya farklı amaçlar için ayrı
// tutulduğundan (bkz. yukarıdaki DEFAULT_DEVICES_FILE notu) burada
// bilerek birleştirilmiyor.
export async function removeDevice(
  deviceId: string,
  devicesFilePath: string = DEFAULT_DEVICES_FILE
): Promise<boolean> {
  const devices = await readDevicesStore(devicesFilePath);
  if (!(deviceId in devices)) return false;

  delete devices[deviceId];
  await writeDevicesStore(devicesFilePath, devices);
  return true;
}

// deviceId'ler randomUUID() ile üretilir - path traversal riski olmasa da
// (dosya yolunda kullanılmıyor), tutarlılık için biçim doğrulaması yapılıyor.
// Bu deseni kullanan HER tüketici (HTTP route'u, deneme-desktop'ın doğrudan
// çağrısı) aynı regex'i paylaşsın diye burada, tek yerde tanımlı.
export const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bir cihazı TAM olarak çıkarır: devices.json kaydı + tokens.json'daki
 * token'ı birlikte siler. Cihaz çıkarmanın TEK doğru yolu bu fonksiyon
 * olmalı — routes/devices.ts'teki HTTP uç noktası VE deneme-desktop'ın
 * Sunucu panelindeki doğrudan (aynı süreç içi, HTTP'siz) çağrısı aynı
 * fonksiyonu kullanır, iki ayrı "cihaz sil" mantığı olmasın diye.
 */
export async function removeDeviceCompletely(
  deviceId: string,
  options?: { tokensFilePath?: string; devicesFilePath?: string }
): Promise<boolean> {
  const removed = await removeDevice(deviceId, options?.devicesFilePath);
  if (!removed) return false;
  await revokeToken(deviceId, options?.tokensFilePath);
  return true;
}

async function runCli(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  let name: string;
  try {
    name = await rl.question("Cihaz adı (örn: mutfak telefonu): ");
  } finally {
    rl.close();
  }

  const result = await pairDevice(name);

  console.log("");
  console.log(`Cihaz eşleştirildi: ${result.name}`);
  console.log(`Cihaz kimliği (deviceId): ${result.deviceId}`);
  console.log("");
  console.log("Aşağıdaki satırı uygulamaya kopyala-yapıştır (token yalnızca burada gösteriliyor):");
  console.log("");

  const payload = JSON.stringify({ deviceId: result.deviceId, token: result.token });
  console.log(payload);
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error("Eşleştirme başarısız:", err);
    process.exitCode = 1;
  });
}
