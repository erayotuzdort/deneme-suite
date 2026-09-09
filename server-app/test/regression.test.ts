// Bu dosya, önceki denetim oturumunda bulunup düzeltilen 6 hata için özel
// regresyon testleri içerir. Her testin başlığı, RAPOR-2026-09-02.md'deki
// "Hata N" numarasına karşılık gelir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { getJson, getRaw, uploadRawMultipart, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
});

after(async () => {
  await server.stop();
});

test("Hata 1 — eşzamanlı aynı-isim yüklemede veri kaybı olmamalı", async () => {
  const CONCURRENCY = 8;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      uploadRawMultipart(server.baseUrl, {
        filenameRaw: "yaris.txt",
        content: `ICERIK-${i}`,
        targetPath: "",
      })
    )
  );

  const successNames = results.filter((r) => r.status === 200).map((r) => r.body.uploaded[0].name);
  assert.equal(successNames.length, CONCURRENCY, "her istek başarılı olmalı");
  assert.equal(new Set(successNames).size, CONCURRENCY, "her istek benzersiz bir ad almalı");

  const filesOnDisk = (await readdir(server.storageRoot)).filter(
    (n) => n.startsWith("yaris") && !n.endsWith(".meta.json")
  );
  assert.equal(filesOnDisk.length, CONCURRENCY, "diskte istek sayısı kadar ayrı dosya olmalı");

  const contents = await Promise.all(
    filesOnDisk.map((n) => readFile(path.join(server.storageRoot, n), "utf-8"))
  );
  const uniqueContents = new Set(contents);
  assert.equal(uniqueContents.size, CONCURRENCY, "hiçbir dosyanın içeriği bir diğerinin üzerine yazılmamalı");
});

test("Hata 2 — depo içinden depo dışına işaret eden junction engellenmeli", async () => {
  const outsideDir = await mkdtemp(path.join(tmpdir(), "deneme-server-outside-"));
  await writeFile(path.join(outsideDir, "gizli.txt"), "GIZLI VERI", "utf-8");

  const junctionPath = path.join(server.storageRoot, "disari-baglanti");
  await symlink(outsideDir, junctionPath, "junction");

  try {
    const listing = await getJson(`${server.baseUrl}/api/files?path=/disari-baglanti`);
    assert.equal(listing.status, 400, "junction üzerinden listeleme engellenmeli");

    const download = await getRaw(`${server.baseUrl}/api/files/download?path=/disari-baglanti/gizli.txt`);
    assert.equal(download.status, 400, "junction üzerinden indirme engellenmeli");

    // normal klasörler junction düzeltmesinden etkilenmemeli
    const normal = await getJson(`${server.baseUrl}/api/files`);
    assert.equal(normal.status, 200);
  } finally {
    await rm(junctionPath, { force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("Hata 3 — çok uzun / yasak karakterli ad artık yanlış 503 vermiyor", async () => {
  const longName = "b".repeat(260) + ".txt";
  const r1 = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: longName,
    content: "x",
    targetPath: "",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.uploaded.length, 0);
  assert.equal(r1.body.skipped[0].reason, "Geçersiz dosya adı");

  const r2 = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: 'yasak<>:"|?*.txt',
    content: "x",
    targetPath: "",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.uploaded.length, 1);
});

test("Hata 4 — Türkçe/emoji dosya adları latin1 olarak bozulmuyor", async () => {
  const r = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: "türkçe İĞÜŞÖÇ regresyon.txt",
    content: "x",
    targetPath: "",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.uploaded[0].name, "türkçe İĞÜŞÖÇ regresyon.txt");
  assert.ok(!r.body.uploaded[0].name.includes("Ã"), "latin1 bozulması (mojibake) olmamalı");
});

test("Hata 5 — hata mesajlarında sunucunun mutlak dosya yolu sızmıyor", async () => {
  const renamedTo = `${server.storageRoot}-RENAMED-REGRESYON`;
  await rename(server.storageRoot, renamedTo);
  try {
    const { status, body } = await getJson(`${server.baseUrl}/api/files`);
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.ok(!body.error.includes(server.storageRoot), "hata mesajı depo yolunu içermemeli");
    assert.ok(!/[a-zA-Z]:\\/.test(body.error), "hata mesajı bir Windows yolu içermemeli");
  } finally {
    await rename(renamedTo, server.storageRoot);
  }
});

test("Hata 6 — indirme yarıda kesilse de sunucu sağlıklı kalmaya devam eder", async () => {
  const bigPath = path.join(server.storageRoot, "buyuk-regresyon.bin");
  await writeFile(bigPath, Buffer.alloc(5_000_000, 65));

  for (let i = 0; i < 10; i++) {
    const controller = new AbortController();
    const p = fetch(`${server.baseUrl}/api/files/download?path=/buyuk-regresyon.bin`, {
      signal: controller.signal,
    }).catch(() => {});
    setTimeout(() => controller.abort(), 10);
    await p;
  }

  // sunucu hâlâ sağlıklı ve normal bir indirme hâlâ doğru sonuç veriyor mu
  const { status, text } = await getRaw(`${server.baseUrl}/api/files/download?path=/indir-yoksa-atla.txt`);
  assert.equal(status, 404); // dosya yok ama sunucu 404 ile düzgün cevap veriyor, çökmedi
  const ping = await getJson(`${server.baseUrl}/ping`);
  assert.equal(ping.status, 200);
});
