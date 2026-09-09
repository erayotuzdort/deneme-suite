import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { uploadChunk, getJson, deleteRequest, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
});

after(async () => {
  await server.stop();
});

function statusUrl(uploadId: string): string {
  return `${server.baseUrl}/api/files/upload/status?uploadId=${encodeURIComponent(uploadId)}`;
}

function pendingUrl(): string {
  return `${server.baseUrl}/api/files/upload/pending`;
}

function deleteUrl(uploadId: string): string {
  return `${server.baseUrl}/api/files/upload/${encodeURIComponent(uploadId)}`;
}

// Bu test dosyadaki İLK test olmalı: "hiç oturum yokken boş dizi döner"
// gerçekten hiçbir chunk oturumu oluşturulmamış, tertemiz bir depoyu
// gerektirir — sonraki testler oturum oluşturmaya başladığında bu koşul
// artık sağlanmaz.
test("pending: hiç oturum yokken boş dizi döner", async () => {
  const r = await getJson(pendingUrl());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.pending, []);
});

// === status ===

test("status: var olan bir oturum için doğru alınan chunk listesini döner", async () => {
  const uploadId = "durum-1";
  await uploadChunk(server.baseUrl, {
    content: "parca-0",
    fields: { uploadId, chunkIndex: 0, totalChunks: 4, fileName: "durum.txt", targetPath: "", note: "durum notu" },
  });
  await uploadChunk(server.baseUrl, {
    content: "parca-1",
    fields: { uploadId, chunkIndex: 1, totalChunks: 4, fileName: "durum.txt", targetPath: "" },
  });
  await uploadChunk(server.baseUrl, {
    content: "parca-3",
    fields: { uploadId, chunkIndex: 3, totalChunks: 4, fileName: "durum.txt", targetPath: "" },
  });

  const r = await getJson(statusUrl(uploadId));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.uploadId, uploadId);
  assert.equal(r.body.fileName, "durum.txt");
  assert.equal(r.body.totalChunks, 4);
  assert.equal(r.body.note, "durum notu");
  assert.equal(r.body.deviceId, server.deviceId);
  assert.deepEqual(r.body.receivedChunkIndexes, [0, 1, 3], "0,1,3 alınmış olmalı, 2 eksik");
});

test("status: olmayan uploadId için 404 döner", async () => {
  const r = await getJson(statusUrl("hic-olmayan-oturum-xyz"));
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test("status: geçersiz uploadId biçimi için 400 döner", async () => {
  const r = await getJson(
    `${server.baseUrl}/api/files/upload/status?uploadId=${encodeURIComponent("../../disari")}`
  );
  assert.equal(r.status, 400);
});

test("status: kimlik doğrulaması olmadan 401 döner", async () => {
  const r = await getJson(statusUrl("herhangi-bir-id"), null);
  assert.equal(r.status, 401);
});

// === pending ===

test("pending: birden fazla bekleyen oturum doğru listelenir", async () => {
  await uploadChunk(server.baseUrl, {
    content: "a",
    fields: { uploadId: "bekleyen-a", chunkIndex: 0, totalChunks: 3, fileName: "a.txt", targetPath: "" },
  });
  await uploadChunk(server.baseUrl, {
    content: "b1",
    fields: { uploadId: "bekleyen-b", chunkIndex: 0, totalChunks: 2, fileName: "b.txt", targetPath: "" },
  });
  await uploadChunk(server.baseUrl, {
    content: "b2",
    fields: { uploadId: "bekleyen-b", chunkIndex: 1, totalChunks: 2, fileName: "b.txt", targetPath: "" },
  });
  // "bekleyen-b" tam bu son parçayla tamamlanıp merge olacak ve pending'den
  // düşecek — bilerek böyle kurguladık (aşağıdaki testte doğrulanıyor).

  const r = await getJson(pendingUrl());
  assert.equal(r.status, 200);
  const ids = r.body.pending.map((p: any) => p.uploadId);
  assert.ok(ids.includes("bekleyen-a"));
  assert.ok(!ids.includes("bekleyen-b"), "tamamlanmış (birleşmiş) oturum pending'de görünmemeli");

  const a = r.body.pending.find((p: any) => p.uploadId === "bekleyen-a");
  assert.equal(a.fileName, "a.txt");
  assert.equal(a.totalChunks, 3);
  assert.equal(a.receivedChunks, 1);
});

test("pending: tamamlanmış (silinmiş) oturum listede görünmez", async () => {
  const uploadId = "tamamlanan-1";
  await uploadChunk(server.baseUrl, {
    content: "tek",
    fields: { uploadId, chunkIndex: 0, totalChunks: 1, fileName: "tamamlanan.txt", targetPath: "" },
  });

  const r = await getJson(pendingUrl());
  const ids = r.body.pending.map((p: any) => p.uploadId);
  assert.ok(!ids.includes(uploadId));
});

test("pending: kimlik doğrulaması olmadan 401 döner", async () => {
  const r = await getJson(pendingUrl(), null);
  assert.equal(r.status, 401);
});

// === delete ===

test("delete: var olan oturum tamamen silinir", async () => {
  const uploadId = "silinecek-1";
  await uploadChunk(server.baseUrl, {
    content: "x",
    fields: { uploadId, chunkIndex: 0, totalChunks: 2, fileName: "silinecek.txt", targetPath: "" },
  });

  const del = await deleteRequest(deleteUrl(uploadId));
  assert.equal(del.status, 204);

  const sessionDir = path.join(server.storageRoot, ".tmp-uploads", uploadId);
  await assert.rejects(
    () => readdir(sessionDir),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    "oturum klasörü tamamen silinmiş olmalı"
  );
});

test("delete: olmayan uploadId için 404 döner", async () => {
  const r = await deleteRequest(deleteUrl("boyle-bir-oturum-yok"));
  assert.equal(r.status, 404);
});

test("delete: silme sonrası status 404, pending'de görünmez", async () => {
  const uploadId = "silinecek-2";
  await uploadChunk(server.baseUrl, {
    content: "x",
    fields: { uploadId, chunkIndex: 0, totalChunks: 2, fileName: "silinecek2.txt", targetPath: "" },
  });

  const del = await deleteRequest(deleteUrl(uploadId));
  assert.equal(del.status, 204);

  const status = await getJson(statusUrl(uploadId));
  assert.equal(status.status, 404);

  const pending = await getJson(pendingUrl());
  const ids = pending.body.pending.map((p: any) => p.uploadId);
  assert.ok(!ids.includes(uploadId));
});

test("delete: geçersiz uploadId biçimi için 400 döner", async () => {
  const r = await deleteRequest(`${server.baseUrl}/api/files/upload/${encodeURIComponent("../../disari")}`);
  assert.equal(r.status, 400);
});

test("delete: kimlik doğrulaması olmadan 401 döner", async () => {
  const r = await deleteRequest(deleteUrl("herhangi-bir-id"), null);
  assert.equal(r.status, 401);
});
