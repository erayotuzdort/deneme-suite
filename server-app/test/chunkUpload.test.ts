import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { uploadChunk, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
  await mkdir(path.join(server.storageRoot, "altklasor"), { recursive: true });
});

after(async () => {
  await server.stop();
});

function sessionDirFor(uploadId: string): string {
  return path.join(server.storageRoot, ".tmp-uploads", uploadId);
}

test("tek parçalık 'dosya' tam akışta hemen tamamlanır", async () => {
  const uploadId = "tek-parca-1";
  const r = await uploadChunk(server.baseUrl, {
    content: "merhaba tek parca",
    fields: { uploadId, chunkIndex: 0, totalChunks: 1, fileName: "tek.txt", targetPath: "" },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.complete, true);
  assert.equal(r.body.receivedChunks, 1);
  assert.equal(r.body.totalChunks, 1);
  assert.equal(r.body.name, "tek.txt");

  const content = await readFile(path.join(server.storageRoot, "tek.txt"), "utf-8");
  assert.equal(content, "merhaba tek parca");
});

test("çok parçalı yükleme doğru sırada ve doğru boyutta birleşir", async () => {
  const uploadId = "cok-parca-1";
  const parts = ["AAAA", "BBBB", "CCCC", "DDDD"];

  for (let i = 0; i < parts.length; i++) {
    const r = await uploadChunk(server.baseUrl, {
      content: parts[i],
      fields: {
        uploadId,
        chunkIndex: i,
        totalChunks: parts.length,
        fileName: "birlesen.txt",
        targetPath: "",
        note: "coklu parca notu",
      },
    });
    assert.equal(r.status, 200);
    if (i < parts.length - 1) {
      assert.equal(r.body.complete, false);
      assert.equal(r.body.receivedChunks, i + 1);
    } else {
      assert.equal(r.body.complete, true);
      assert.equal(r.body.name, "birlesen.txt");
    }
  }

  const merged = await readFile(path.join(server.storageRoot, "birlesen.txt"), "utf-8");
  assert.equal(merged, parts.join(""), "parçalar tam olarak sıralı birleşmeli");

  const meta = JSON.parse(
    await readFile(path.join(server.storageRoot, "birlesen.txt.meta.json"), "utf-8")
  );
  assert.equal(meta.note, "coklu parca notu");
  assert.equal(meta.uploadedBy, server.deviceId);
});

// deneme-app istemcisi artık 20MB üstü dosyaları alt klasöre yüklerken de
// bu uca (targetPath dolu + chunk) düşüyor - "" targetPath ile alt klasör
// arasındaki tek fark resolveExistingDirectory'nin gerçek bir klasörü
// doğrulaması, bu yüzden ayrıca test edilmeye değer (regular upload'ta
// zaten test ediliyordu, chunk ucunda hiç yoktu).
test("çok parçalı yükleme bir alt klasöre (targetPath) doğru birleşir", async () => {
  const uploadId = "altklasor-parca-1";
  const parts = ["1111", "2222", "3333"];

  let lastResponse;
  for (let i = 0; i < parts.length; i++) {
    lastResponse = await uploadChunk(server.baseUrl, {
      content: parts[i],
      fields: {
        uploadId,
        chunkIndex: i,
        totalChunks: parts.length,
        fileName: "altklasordeki.txt",
        targetPath: "/altklasor",
        note: "alt klasor notu",
      },
    });
    assert.equal(lastResponse.status, 200);
  }

  assert.equal(lastResponse!.body.complete, true);
  assert.equal(lastResponse!.body.path, "/altklasor/altklasordeki.txt");

  const merged = await readFile(path.join(server.storageRoot, "altklasor", "altklasordeki.txt"), "utf-8");
  assert.equal(merged, parts.join(""));

  const meta = JSON.parse(
    await readFile(path.join(server.storageRoot, "altklasor", "altklasordeki.txt.meta.json"), "utf-8")
  );
  assert.equal(meta.note, "alt klasor notu");
});

test("olmayan hedef klasöre chunk yüklemesi 404 döner", async () => {
  const r = await uploadChunk(server.baseUrl, {
    content: "x",
    fields: {
      uploadId: "olmayan-klasor-1",
      chunkIndex: 0,
      totalChunks: 1,
      fileName: "x.txt",
      targetPath: "/yok-boyle-klasor",
    },
  });
  assert.equal(r.status, 404);
});

test("aralık dışı chunkIndex 400 ile reddedilir", async () => {
  const uploadId = "araliki-disi-1";
  const r1 = await uploadChunk(server.baseUrl, {
    content: "x",
    fields: { uploadId, chunkIndex: -1, totalChunks: 3, fileName: "x.txt", targetPath: "" },
  });
  assert.equal(r1.status, 400);

  const r2 = await uploadChunk(server.baseUrl, {
    content: "x",
    fields: { uploadId, chunkIndex: 3, totalChunks: 3, fileName: "x.txt", targetPath: "" },
  });
  assert.equal(r2.status, 400);
});

test("totalChunks önceki parçalarla uyuşmuyorsa 400 döner", async () => {
  const uploadId = "uyusmazlik-1";
  const first = await uploadChunk(server.baseUrl, {
    content: "ilk",
    fields: { uploadId, chunkIndex: 0, totalChunks: 3, fileName: "uyusmazlik.txt", targetPath: "" },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.complete, false);

  const second = await uploadChunk(server.baseUrl, {
    content: "ikinci",
    fields: { uploadId, chunkIndex: 1, totalChunks: 5, fileName: "uyusmazlik.txt", targetPath: "" },
  });
  assert.equal(second.status, 400);
});

test("aynı parçanın tekrar gönderimi çift kayıt oluşturmaz (idempotent)", async () => {
  const uploadId = "idempotent-1";
  const r1 = await uploadChunk(server.baseUrl, {
    content: "ilk-gonderim",
    fields: { uploadId, chunkIndex: 0, totalChunks: 2, fileName: "idempotent.txt", targetPath: "" },
  });
  assert.equal(r1.body.receivedChunks, 1);

  // Ayni chunkIndex'i FARKLI icerikle tekrar gonder — uzerine yazmali,
  // ikinci bir .part dosyasi olusturmamali.
  const r2 = await uploadChunk(server.baseUrl, {
    content: "tekrar-gonderim-farkli-icerik",
    fields: { uploadId, chunkIndex: 0, totalChunks: 2, fileName: "idempotent.txt", targetPath: "" },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.receivedChunks, 1, "aynı chunkIndex tekrar sayılmamalı");

  const parts = (await readdir(sessionDirFor(uploadId))).filter((n) => n.endsWith(".part"));
  assert.equal(parts.length, 1);
  const partContent = await readFile(path.join(sessionDirFor(uploadId), "0000.part"), "utf-8");
  assert.equal(partContent, "tekrar-gonderim-farkli-icerik", "en son gönderilen içerik geçerli olmalı");
});

test("tüm parçalar tamamlanmadan birleşme gerçekleşmez", async () => {
  const uploadId = "eksik-parca-1";
  const r = await uploadChunk(server.baseUrl, {
    content: "sadece-ilk-parca",
    fields: { uploadId, chunkIndex: 0, totalChunks: 3, fileName: "eksik.txt", targetPath: "" },
  });
  assert.equal(r.body.complete, false);

  const listing = await readdir(server.storageRoot);
  assert.ok(!listing.includes("eksik.txt"), "nihai dosya henüz oluşmamalı");

  const sessionExists = await readdir(sessionDirFor(uploadId));
  assert.ok(sessionExists.includes(".session.json"), "oturum dosyası hâlâ mevcut olmalı");
});

test("birleşme sonrası geçici oturum klasörü tamamen silinir", async () => {
  const uploadId = "temizlik-1";
  await uploadChunk(server.baseUrl, {
    content: "parca-a",
    fields: { uploadId, chunkIndex: 0, totalChunks: 2, fileName: "temizlik.txt", targetPath: "" },
  });
  const r = await uploadChunk(server.baseUrl, {
    content: "parca-b",
    fields: { uploadId, chunkIndex: 1, totalChunks: 2, fileName: "temizlik.txt", targetPath: "" },
  });
  assert.equal(r.body.complete, true);

  await assert.rejects(
    () => readdir(sessionDirFor(uploadId)),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    "birleşme sonrası <uploadId> klasörü tamamen silinmiş olmalı"
  );
});

test("geçersiz karakter içeren uploadId reddedilir (path traversal koruması)", async () => {
  const r = await uploadChunk(server.baseUrl, {
    content: "x",
    fields: { uploadId: "../../disari-cikma", chunkIndex: 0, totalChunks: 1, fileName: "x.txt", targetPath: "" },
  });
  assert.equal(r.status, 400);
});

test("ilk parçada fileName eksikse 400 döner", async () => {
  const r = await uploadChunk(server.baseUrl, {
    content: "x",
    fields: { uploadId: "isim-eksik-1", chunkIndex: 0, totalChunks: 1, targetPath: "" },
  });
  assert.equal(r.status, 400);
});

test("hedefte aynı adlı dosya varsa mevcut çakışma numaralandırması uygulanır", async () => {
  const first = await uploadChunk(server.baseUrl, {
    content: "ilk dosya",
    fields: { uploadId: "cakisan-a", chunkIndex: 0, totalChunks: 1, fileName: "cakisan.txt", targetPath: "" },
  });
  assert.equal(first.body.name, "cakisan.txt");

  const second = await uploadChunk(server.baseUrl, {
    content: "ikinci dosya",
    fields: { uploadId: "cakisan-b", chunkIndex: 0, totalChunks: 1, fileName: "cakisan.txt", targetPath: "" },
  });
  assert.equal(second.body.name, "cakisan (1).txt", "aynı ad varsa mevcut (1) numaralandırması uygulanmalı");

  const original = await readFile(path.join(server.storageRoot, "cakisan.txt"), "utf-8");
  const numbered = await readFile(path.join(server.storageRoot, "cakisan (1).txt"), "utf-8");
  assert.equal(original, "ilk dosya");
  assert.equal(numbered, "ikinci dosya");
});

test("kimlik doğrulaması olmadan 401 döner", async () => {
  const r = await uploadChunk(server.baseUrl, {
    content: "x",
    fields: { uploadId: "auth-testi-1", chunkIndex: 0, totalChunks: 1, fileName: "x.txt", targetPath: "" },
    headers: null,
  });
  assert.equal(r.status, 401);
});
