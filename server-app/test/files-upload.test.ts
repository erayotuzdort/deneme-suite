import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { uploadMultipart, uploadRawMultipart, getJson, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
  await mkdir(path.join(server.storageRoot, "altklasor"), { recursive: true });
});

after(async () => {
  await server.stop();
});

test("çoklu dosya + not, köke", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [
      { filename: "coklu-a.txt", content: "icerik a" },
      { filename: "coklu-b.txt", content: "icerik bb" },
    ],
    fields: { note: "ortak not", targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.uploaded.length, 2);
  const metaA = JSON.parse(
    await readFile(path.join(server.storageRoot, "coklu-a.txt.meta.json"), "utf-8")
  );
  assert.equal(metaA.note, "ortak not");
});

test("tek dosya, notsuz, alt klasöre", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "tekli.txt", content: "tekli icerik" }],
    fields: { targetPath: "/altklasor" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded[0].path, "/altklasor/tekli.txt");
  const meta = JSON.parse(
    await readFile(path.join(server.storageRoot, "altklasor", "tekli.txt.meta.json"), "utf-8")
  );
  assert.equal(meta.note, null);
});

// REGRESYON (deneme-desktop turu, "dosya gönderilirken not boş bırakılsa
// bile gereksiz bir .txt dosyası da oluşuyor" şikayeti): kod okunarak ve
// mevcut testler çalıştırılarak bu davranış BU HALİYLE yeniden üretilemedi
// (routes/files.ts'teki upload handler'ı, .txt oluşturmayı yalnızca
// files.length === 0 koşuluna bağlıyor - dosya olduğunda not boş da olsa
// dolu da olsa .txt YOLUNA hiç girilmiyor). Yine de kesin, açık bir
// regresyon güvencesi olsun diye - ve gelecekte biri bu koşulu yanlışlıkla
// (ör. "!note" gibi) değiştirirse hemen kırılsın diye - üç senaryo da
// burada, dizin içeriği doğrudan denetlenerek (sadece body.uploaded
// alanına güvenmeden) test ediliyor.
test("REGRESYON: dosya + boş not -> sadece dosya yazılır, gereksiz .txt oluşmaz", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "bosnotlu.txt", content: "dosya icerigi" }],
    fields: { note: "", targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 1);
  assert.equal(body.uploaded[0].name, "bosnotlu.txt");

  const entries = await readdir(server.storageRoot);
  const related = entries.filter((n) => n.startsWith("bosnotlu"));
  assert.deepEqual(related.sort(), ["bosnotlu.txt", "bosnotlu.txt.meta.json"]);
  assert.deepEqual(
    entries.filter((n) => n.startsWith("not-")),
    [],
    "dosya yüklemesi hiçbir 'not-*.txt' dosyası oluşturmamalı"
  );

  const meta = JSON.parse(await readFile(path.join(server.storageRoot, "bosnotlu.txt.meta.json"), "utf-8"));
  assert.equal(meta.note, null);
});

test("REGRESYON: dosya + dolu not -> dosya + .meta.json, ayrı bir .txt oluşmaz", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "dolunotlu.txt", content: "dosya icerigi 2" }],
    fields: { note: "bu bir not", targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 1);

  const entries = await readdir(server.storageRoot);
  const related = entries.filter((n) => n.startsWith("dolunotlu"));
  assert.deepEqual(related.sort(), ["dolunotlu.txt", "dolunotlu.txt.meta.json"]);
  assert.deepEqual(
    entries.filter((n) => n.startsWith("not-")),
    [],
    "dosya + not birlikte gönderilmesi ayrı bir 'not-*.txt' oluşturmamalı"
  );

  const meta = JSON.parse(await readFile(path.join(server.storageRoot, "dolunotlu.txt.meta.json"), "utf-8"));
  assert.equal(meta.note, "bu bir not");
});

test("REGRESYON: sadece not (dosya yok) -> not-*.txt dosyası oluşur", async () => {
  const before = new Set(await readdir(server.storageRoot));
  const { status, body } = await uploadMultipart(server.baseUrl, {
    fields: { note: "yalniz not testi", targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 1);
  assert.match(body.uploaded[0].name, /^not-.*\.txt$/);

  const after = await readdir(server.storageRoot);
  const newTxtFiles = after.filter((n) => !before.has(n) && n.endsWith(".txt") && !n.endsWith(".meta.json"));
  assert.equal(newTxtFiles.length, 1);
  assert.match(newTxtFiles[0], /^not-/);
});

test("aynı isim 3 kez üst üste doğru numaralandırılır", async () => {
  for (let i = 0; i < 3; i++) {
    const { status } = await uploadMultipart(server.baseUrl, {
      files: [{ filename: "cakisan.txt", content: `deneme ${i}` }],
      fields: { targetPath: "" },
    });
    assert.equal(status, 200);
  }
  const names = (await readdir(server.storageRoot)).filter((n) => n.startsWith("cakisan"));
  assert.ok(names.includes("cakisan.txt"));
  assert.ok(names.includes("cakisan (1).txt"));
  assert.ok(names.includes("cakisan (2).txt"));
});

test("sadece not (dosyasız)", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    fields: { note: "sadece not testi", targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 1);
  const content = await readFile(path.join(server.storageRoot, body.uploaded[0].name), "utf-8");
  assert.equal(content, "sadece not testi");
});

test("ne dosya ne not 400 döner", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, { fields: { targetPath: "" } });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test("olmayan hedef klasör 404 döner", async () => {
  const { status } = await uploadMultipart(server.baseUrl, {
    fields: { note: "x", targetPath: "/yok-boyle-klasor" },
  });
  assert.equal(status, 404);
});

test("hedef bir dosyaysa 400 döner", async () => {
  await uploadMultipart(server.baseUrl, {
    files: [{ filename: "hedef-dosya.txt", content: "x" }],
    fields: { targetPath: "" },
  });
  const { status } = await uploadMultipart(server.baseUrl, {
    fields: { note: "x", targetPath: "/hedef-dosya.txt" },
  });
  assert.equal(status, 400);
});

test("targetPath depo dışına çıkarsa 400 döner", async () => {
  const { status } = await uploadMultipart(server.baseUrl, {
    fields: { note: "x", targetPath: "/../../" },
  });
  assert.equal(status, 400);
});

test("path traversal içeren dosya adı güvenle temizlenir", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "../../disari-cikma-denemesi.txt", content: "x" }],
    fields: { targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded[0].name, "disari-cikma-denemesi.txt");
  assert.equal(body.uploaded[0].path, "/disari-cikma-denemesi.txt");
});

test("Windows ADS denemesi (:) temizlenir", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "zararli.txt:gizli.exe", content: "x" }],
    fields: { targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded[0].name, "zararli.txt_gizli.exe");
});

test("sadece uzantıdan ibaret ad (.jpg) atlanır", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: ".jpg", content: "x" }],
    fields: { targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 0);
  assert.equal(body.skipped[0].name, ".jpg");
});

test("boş dosya adı: dosya yoksayılır, not varsa yine de kaydedilir", async () => {
  const { status, body } = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: "",
    content: "x",
    note: "bos ad + not",
    targetPath: "",
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 1);
});

test("255+ karakter dosya adı atlanır, yanlış 503 dönmez", async () => {
  const longName = "a".repeat(260) + ".txt";
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: longName, content: "x" }],
    fields: { targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 0);
  assert.equal(body.skipped[0].reason, "Geçersiz dosya adı");
});

test("Türkçe karakterli ve boşluklu ad doğru kaydedilir", async () => {
  const { status, body } = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: "türkçe İĞÜŞÖÇ dosya adı.txt",
    content: "x",
    targetPath: "",
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded[0].name, "türkçe İĞÜŞÖÇ dosya adı.txt");
});

test("emoji içeren ad doğru kaydedilir", async () => {
  const emojiName = String.fromCodePoint(0x1f600) + String.fromCodePoint(0x1f680) + "dosya.txt";
  const { status, body } = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: emojiName,
    content: "x",
    targetPath: "",
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded[0].name, emojiName);
});

test("Windows'ta yasak karakterler temizlenir", async () => {
  const { status, body } = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: 'ad<>:"|?*.txt',
    content: "x",
    targetPath: "",
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded.length, 1);
  assert.ok(!/[<>:"|?*]/.test(body.uploaded[0].name));
});

test("rezerve adlar (CON, NUL, COM1) gerçek dosya olarak oluşur", async () => {
  for (const reserved of ["CON", "NUL", "COM1"]) {
    const { status, body } = await uploadRawMultipart(server.baseUrl, {
      filenameRaw: reserved,
      content: "rezerve icerik",
      targetPath: "",
    });
    assert.equal(status, 200, `${reserved} yüklemesi başarısız`);
    assert.equal(body.uploaded[0].name, reserved);
    const filePath = path.join(server.storageRoot, reserved);
    const st = await stat(filePath);
    assert.ok(st.isFile(), `${reserved} gerçek bir dosya değil`);
    const listing = await getJson(`${server.baseUrl}/api/files`);
    assert.ok(
      listing.body.entries.some((e: any) => e.name === reserved),
      `${reserved} listelemede görünmüyor`
    );
  }
});

test("0 bayt dosya yüklenebilir", async () => {
  const { status, body } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "sifir-yukleme.txt", content: Buffer.alloc(0) }],
    fields: { targetPath: "" },
  });
  assert.equal(status, 200);
  assert.equal(body.uploaded[0].size, 0);
});
