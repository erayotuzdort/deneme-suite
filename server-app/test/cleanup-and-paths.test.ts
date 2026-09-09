// QA turunda bulunup düzeltilen üç sunucu hatasının regresyon testleri:
//   D5  — yarım kalan parçalı yükleme oturumları (KLASÖR) temizlenmiyordu
//   D17 — NTFS alternatif veri akışı soneki depo içi takma ad üretiyordu
//   D19 — eşi silinmiş .meta.json dosyaları sonsuza kadar birikiyordu
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { getJson, setDefaultHeaders, uploadMultipart } from "./helpers/http";
import { cleanupOrphanedMetaFiles, cleanupOrphanedTempUploads, TEMP_UPLOAD_DIR_NAME } from "../src/upload";
import { config } from "../src/config";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
});

after(async () => {
  await server.stop();
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// --- D5 -------------------------------------------------------------------

test("D5) açılış temizliği yarım kalmış parça oturumu KLASÖRÜNÜ de siler", async () => {
  // cleanupOrphanedTempUploads config.storageRoot'u okuyor; bu test süreci
  // sunucunun kendi süreci DEĞİL, o yüzden kökü burada gösteriyoruz.
  config.storageRoot = server.storageRoot;
  const tempDir = path.join(server.storageRoot, TEMP_UPLOAD_DIR_NAME);
  const sessionDir = path.join(tempDir, "up-yarim-kalan");

  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, ".session.json"),
    JSON.stringify({ targetPath: "/", note: null, deviceId: null, totalChunks: 5, fileName: "yarim.bin", createdAt: new Date().toISOString() }),
    "utf-8"
  );
  await writeFile(path.join(sessionDir, "0000.part"), "parca-0", "utf-8");
  await writeFile(path.join(sessionDir, "0001.part"), "parca-1", "utf-8");
  // Eski şekil: düz geçici dosya. İkisi birlikte temizlenmeli.
  await writeFile(path.join(tempDir, "duz-gecici-dosya"), "x", "utf-8");

  const deleted = await cleanupOrphanedTempUploads();

  assert.equal(deleted, 2, "biri klasör biri dosya, iki girdi de silinmiş sayılmalı");
  assert.equal(await exists(sessionDir), false, "parça oturumu klasörü silinmeliydi");
  assert.equal(await exists(path.join(tempDir, "duz-gecici-dosya")), false, "düz geçici dosya da silinmeliydi");
  assert.deepEqual(await readdir(tempDir), [], ".tmp-uploads tamamen boşalmalı");
});

test("D5) .tmp-uploads hiç yoksa temizlik 0 döner, hata fırlatmaz", async () => {
  config.storageRoot = server.storageRoot;
  await rm(path.join(server.storageRoot, TEMP_UPLOAD_DIR_NAME), { recursive: true, force: true });
  assert.equal(await cleanupOrphanedTempUploads(), 0);
});

// --- D17 ------------------------------------------------------------------

test("D17) ADS soneki ile klasör listelemesi reddedilir", async () => {
  await mkdir(path.join(server.storageRoot, "ads-klasor"), { recursive: true });
  await uploadMultipart(`${server.baseUrl}/api/files/upload`, {
    files: [{ filename: "icerik.txt", content: "ADS testi" }],
    fields: { targetPath: "/ads-klasor" },
  });

  // Kontrol: sonek olmadan çalışıyor.
  const temiz = await getJson(`${server.baseUrl}/api/files?path=${encodeURIComponent("/ads-klasor")}`);
  assert.equal(temiz.status, 200);

  const ads = await getJson(
    `${server.baseUrl}/api/files?path=${encodeURIComponent("/ads-klasor::$INDEX_ALLOCATION")}`
  );
  assert.equal(ads.status, 400, "ADS takma adı 400 ile reddedilmeli");
  assert.match(String(ads.body?.error ?? ""), /depo kökünün dışına/i);
});

test("D17) ADS soneki ile dosya indirme reddedilir", async () => {
  const ads = await getJson(
    `${server.baseUrl}/api/files/download?path=${encodeURIComponent("/ads-klasor/icerik.txt:gizli")}`
  );
  assert.equal(ads.status, 400, "dosya akışı takma adı da reddedilmeli");
});

// --- D19 ------------------------------------------------------------------

test("D19) eşi olmayan .meta.json silinir, eşi duran korunur", async () => {
  config.storageRoot = server.storageRoot;
  const root = server.storageRoot;
  const altKlasor = path.join(root, "meta-alt");
  await mkdir(altKlasor, { recursive: true });

  // (a) eşi DURAN meta — korunmalı
  await writeFile(path.join(root, "duran.txt"), "veri", "utf-8");
  await writeFile(path.join(root, "duran.txt.meta.json"), "{}", "utf-8");
  // (b) eşi SİLİNMİŞ meta — temizlenmeli
  await writeFile(path.join(root, "silinmis.txt.meta.json"), "{}", "utf-8");
  // (c) alt klasörde eşi silinmiş meta — özyinelemeli temizlenmeli
  await writeFile(path.join(altKlasor, "derin.jpg.meta.json"), "{}", "utf-8");

  const deleted = await cleanupOrphanedMetaFiles();

  assert.equal(deleted, 2, "yalnızca iki yetim meta silinmeliydi");
  assert.equal(await exists(path.join(root, "duran.txt.meta.json")), true, "eşi duran meta korunmalı");
  assert.equal(await exists(path.join(root, "duran.txt")), true, "asıl dosyaya dokunulmamalı");
  assert.equal(await exists(path.join(root, "silinmis.txt.meta.json")), false);
  assert.equal(await exists(path.join(altKlasor, "derin.jpg.meta.json")), false);
});

test("D19) temizlik normal dosyalara ve not dosyalarına dokunmaz", async () => {
  config.storageRoot = server.storageRoot;
  const root = server.storageRoot;
  await writeFile(path.join(root, "dokunma.txt"), "veri", "utf-8");
  await writeFile(path.join(root, "not-2026-01-01T00-00-00-000Z.txt"), "not", "utf-8");
  await writeFile(path.join(root, "not-2026-01-01T00-00-00-000Z.txt.meta.json"), "{}", "utf-8");

  await cleanupOrphanedMetaFiles();

  assert.equal(await exists(path.join(root, "dokunma.txt")), true);
  assert.equal(await exists(path.join(root, "not-2026-01-01T00-00-00-000Z.txt")), true);
  assert.equal(
    await exists(path.join(root, "not-2026-01-01T00-00-00-000Z.txt.meta.json")),
    true,
    "eşi duran not meta'sı korunmalı"
  );
});
