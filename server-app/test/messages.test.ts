import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { uploadMultipart, getJson, deleteRequest, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
  await mkdir(path.join(server.storageRoot, "altklasor"), { recursive: true });
});

after(async () => {
  await server.stop();
});

test("GET /api/messages kimlik doğrulama olmadan 401 döner", async () => {
  const { status } = await getJson(`${server.baseUrl}/api/messages`, null);
  assert.equal(status, 401);
});

test("GET /api/messages sadece not-only dosyaları listeler, normal dosyaları listelemez", async () => {
  // Bir normal dosya + bir not-only mesaj yükle.
  await uploadMultipart(server.baseUrl, {
    files: [{ filename: "normal-dosya.txt", content: "normal icerik" }],
    fields: { targetPath: "" },
  });
  const noteUpload = await uploadMultipart(server.baseUrl, {
    fields: { note: "listelenecek mesaj", targetPath: "" },
  });
  assert.equal(noteUpload.status, 200);
  const messageFileName = noteUpload.body.uploaded[0].name;

  const { status, body } = await getJson(`${server.baseUrl}/api/messages`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.messages));

  const found = body.messages.find((m: any) => m.fileName === messageFileName);
  assert.ok(found, "yüklenen not mesajı listede olmalı");
  assert.equal(found.note, "listelenecek mesaj");
  assert.equal(found.id, `/${messageFileName}`);

  const normalListed = body.messages.some((m: any) => m.fileName === "normal-dosya.txt");
  assert.equal(normalListed, false, "normal dosya mesaj listesinde görünmemeli");
});

test("GET /api/messages alt klasörlerdeki mesajları da bulur (recursive)", async () => {
  const noteUpload = await uploadMultipart(server.baseUrl, {
    fields: { note: "alt klasör mesajı", targetPath: "/altklasor" },
  });
  assert.equal(noteUpload.status, 200);
  const messageFileName = noteUpload.body.uploaded[0].name;

  const { body } = await getJson(`${server.baseUrl}/api/messages`);
  const found = body.messages.find((m: any) => m.fileName === messageFileName);
  assert.ok(found, "alt klasördeki mesaj da listede olmalı");
  assert.equal(found.id, `/altklasor/${messageFileName}`);
});

test("DELETE /api/messages kimlik doğrulama olmadan 401 döner", async () => {
  const { status } = await deleteRequest(`${server.baseUrl}/api/messages?path=${encodeURIComponent("/yok.txt")}`, null);
  assert.equal(status, 401);
});

test("DELETE /api/messages path parametresi eksikse 400 döner", async () => {
  const { status } = await deleteRequest(`${server.baseUrl}/api/messages`);
  assert.equal(status, 400);
});

test("DELETE /api/messages var olmayan mesaj için 404 döner", async () => {
  const { status } = await deleteRequest(`${server.baseUrl}/api/messages?path=${encodeURIComponent("/hic-olmayan.txt")}`);
  assert.equal(status, 404);
});

test("DELETE /api/messages normal (not-only OLMAYAN) bir dosyayı silmeyi reddeder (404) - genel amaçlı silme değil", async () => {
  await uploadMultipart(server.baseUrl, {
    files: [{ filename: "silinemez.txt", content: "bu normal bir dosya" }],
    fields: { targetPath: "" },
  });

  const { status } = await deleteRequest(`${server.baseUrl}/api/messages?path=${encodeURIComponent("/silinemez.txt")}`);
  assert.equal(status, 404);

  // Dosya hâlâ diskte olmalı - silinmemiş.
  const stats = await stat(path.join(server.storageRoot, "silinemez.txt"));
  assert.ok(stats.isFile());
});

test("DELETE /api/messages gerçek bir mesajı diskten (dosya + .meta.json) siler", async () => {
  const noteUpload = await uploadMultipart(server.baseUrl, {
    fields: { note: "silinecek mesaj", targetPath: "" },
  });
  assert.equal(noteUpload.status, 200);
  const messageFileName = noteUpload.body.uploaded[0].name;
  const filePath = path.join(server.storageRoot, messageFileName);
  const metaPath = `${filePath}.meta.json`;

  // Silmeden önce gerçekten var olduğunu doğrula.
  await stat(filePath);
  await stat(metaPath);

  const { status, body } = await deleteRequest(`${server.baseUrl}/api/messages?path=${encodeURIComponent(`/${messageFileName}`)}`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  await assert.rejects(() => stat(filePath), "dosya diskten silinmiş olmalı");
  await assert.rejects(() => stat(metaPath), ".meta.json da diskten silinmiş olmalı");

  const { body: afterList } = await getJson(`${server.baseUrl}/api/messages`);
  const stillThere = afterList.messages.some((m: any) => m.fileName === messageFileName);
  assert.equal(stillThere, false, "silinen mesaj listede artık görünmemeli");
});

test("DELETE /api/messages aynı mesajı iki kez silmek ikinci seferde 404 döner", async () => {
  const noteUpload = await uploadMultipart(server.baseUrl, {
    fields: { note: "iki kez silinen", targetPath: "" },
  });
  const messageFileName = noteUpload.body.uploaded[0].name;
  const url = `${server.baseUrl}/api/messages?path=${encodeURIComponent(`/${messageFileName}`)}`;

  const first = await deleteRequest(url);
  assert.equal(first.status, 200);

  const second = await deleteRequest(url);
  assert.equal(second.status, 404);
});

test(".meta.json'da isNoteOnly:true doğru yazılıyor, normal dosyada bu alan hiç yok", async () => {
  await uploadMultipart(server.baseUrl, {
    files: [{ filename: "meta-kontrol.txt", content: "icerik" }],
    fields: { targetPath: "" },
  });
  const normalMeta = JSON.parse(await readFile(path.join(server.storageRoot, "meta-kontrol.txt.meta.json"), "utf-8"));
  assert.equal("isNoteOnly" in normalMeta, false);

  const noteUpload = await uploadMultipart(server.baseUrl, {
    fields: { note: "meta kontrolü", targetPath: "" },
  });
  const messageFileName = noteUpload.body.uploaded[0].name;
  const noteMeta = JSON.parse(await readFile(path.join(server.storageRoot, `${messageFileName}.meta.json`), "utf-8"));
  assert.equal(noteMeta.isNoteOnly, true);
});
