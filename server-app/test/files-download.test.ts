import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { getRaw, setDefaultHeaders } from "./helpers/http";

let server: TestServer;
const CONTENT = "0123456789"; // 10 bayt, aralik testleri icin kolay hesaplanir

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
  await writeFile(path.join(server.storageRoot, "indir.txt"), CONTENT, "utf-8");
  await writeFile(path.join(server.storageRoot, "sifir.txt"), "", "utf-8");
});

after(async () => {
  await server.stop();
});

test("Range'siz indirme tüm içeriği döner", async () => {
  const { status, text } = await getRaw(`${server.baseUrl}/api/files/download?path=/indir.txt`);
  assert.equal(status, 200);
  assert.equal(text, CONTENT);
});

test("bytes=0-4 doğru parçayı döner", async () => {
  const { status, text } = await getRaw(`${server.baseUrl}/api/files/download?path=/indir.txt`, {
    Range: "bytes=0-4",
  });
  assert.equal(status, 206);
  assert.equal(text, "01234");
});

test("bytes=5- doğru parçayı döner", async () => {
  const { status, text } = await getRaw(`${server.baseUrl}/api/files/download?path=/indir.txt`, {
    Range: "bytes=5-",
  });
  assert.equal(status, 206);
  assert.equal(text, "56789");
});

test("çoklu aralık 416 döner", async () => {
  const { status } = await getRaw(`${server.baseUrl}/api/files/download?path=/indir.txt`, {
    Range: "bytes=0-2,5-7",
  });
  assert.equal(status, 416);
});

test("bozuk Range sözdizimi 400 döner", async () => {
  const { status } = await getRaw(`${server.baseUrl}/api/files/download?path=/indir.txt`, {
    Range: "bytes=abc-def",
  });
  assert.equal(status, 400);
});

test("dosya boyutunu aşan start 416 döner", async () => {
  const { status } = await getRaw(`${server.baseUrl}/api/files/download?path=/indir.txt`, {
    Range: "bytes=9999-",
  });
  assert.equal(status, 416);
});

test("0 bayt dosya indirilebilir", async () => {
  const { status, text } = await getRaw(`${server.baseUrl}/api/files/download?path=/sifir.txt`);
  assert.equal(status, 200);
  assert.equal(text, "");
});

test("path parametresi eksikse 400 döner", async () => {
  const { status } = await getRaw(`${server.baseUrl}/api/files/download`);
  assert.equal(status, 400);
});

test("olmayan dosya 404 döner", async () => {
  const { status } = await getRaw(`${server.baseUrl}/api/files/download?path=/yok.txt`);
  assert.equal(status, 404);
});

test("klasör verilirse 400 döner", async () => {
  const { status } = await getRaw(`${server.baseUrl}/api/files/download?path=/`);
  assert.equal(status, 400);
});

test("depo dışına çıkan yol 400 döner", async () => {
  const { status } = await getRaw(`${server.baseUrl}/api/files/download?path=/../../../windows/win.ini`);
  assert.equal(status, 400);
});
