import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { getJson, getRaw, uploadMultipart } from "./helpers/http";
import { generateToken } from "../src/auth";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  await writeFile(path.join(server.storageRoot, "korumali-dosya.txt"), "icerik", "utf-8");
});

after(async () => {
  await server.stop();
});

test("geçerli token ile korumalı bir uç nokta 200 döner", async () => {
  const { status } = await getJson(`${server.baseUrl}/api/files`, server.authHeaders);
  assert.equal(status, 200);
});

test("yanlış (uydurma) token 401 döner", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files`, {
    "X-Device-Id": server.deviceId,
    Authorization: "Bearer " + "0".repeat(64),
  });
  assert.equal(status, 401);
  assert.equal(body.ok, false);
});

test("X-Device-Id header'ı eksikse 401 döner", async () => {
  const { status } = await getJson(`${server.baseUrl}/api/files`, {
    Authorization: server.authHeaders.Authorization,
  });
  assert.equal(status, 401);
});

test("Authorization header'ı eksikse 401 döner", async () => {
  const { status } = await getJson(`${server.baseUrl}/api/files`, {
    "X-Device-Id": server.deviceId,
  });
  assert.equal(status, 401);
});

test("Authorization header'ı 'Bearer' önekini taşımıyorsa 401 döner", async () => {
  const { status } = await getJson(`${server.baseUrl}/api/files`, {
    "X-Device-Id": server.deviceId,
    Authorization: server.authHeaders.Authorization.replace(/^Bearer /, ""),
  });
  assert.equal(status, 401);
});

test("başka bir cihazın geçerli token'ı, bu cihaz için geçersizdir (yanlış eşleşme)", async () => {
  const otherDeviceId = "baska-bir-cihaz";
  const otherToken = await generateToken(otherDeviceId, server.tokensFilePath);
  // otherToken gerçek ve geçerli bir token, ama server.deviceId ile eşleşmiyor.
  const { status } = await getJson(`${server.baseUrl}/api/files`, {
    "X-Device-Id": server.deviceId,
    Authorization: `Bearer ${otherToken}`,
  });
  assert.equal(status, 401);

  // Kendi token'ıyla kendi deviceId'si hâlâ çalışmalı (çapraz kontrol).
  const own = await getJson(`${server.baseUrl}/api/files`, {
    "X-Device-Id": otherDeviceId,
    Authorization: `Bearer ${otherToken}`,
  });
  assert.equal(own.status, 200);
});

test("/ping kimlik doğrulama olmadan çalışmaya devam eder", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/ping`, null);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("korunan 4 uç noktanın hepsi kimlik doğrulama olmadan 401 döner", async () => {
  const getFiles = await getJson(`${server.baseUrl}/api/files`, null);
  assert.equal(getFiles.status, 401, "GET /api/files");

  const download = await getRaw(
    `${server.baseUrl}/api/files/download?path=/korumali-dosya.txt`,
    null
  );
  assert.equal(download.status, 401, "GET /api/files/download");

  const upload = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "x.txt", content: "x" }],
    headers: null,
  });
  assert.equal(upload.status, 401, "POST /api/files/upload");

  const devices = await getJson(`${server.baseUrl}/api/devices`, null);
  assert.equal(devices.status, 401, "GET /api/devices");
});

test("401 yanıtları hangi header'ın eksik/yanlış olduğunu ayırt etmez (jenerik mesaj)", async () => {
  const missingBoth = await getJson(`${server.baseUrl}/api/files`, null);
  const wrongToken = await getJson(`${server.baseUrl}/api/files`, {
    "X-Device-Id": server.deviceId,
    Authorization: "Bearer " + "1".repeat(64),
  });

  assert.equal(missingBoth.status, 401);
  assert.equal(wrongToken.status, 401);
  assert.equal(typeof missingBoth.body.error, "string");
  assert.equal(typeof wrongToken.body.error, "string");
  // Ne header adı ne de "böyle bir cihaz yok" gibi ayırt edici bilgi sızmalı.
  assert.ok(!/device|authorization|bearer/i.test(missingBoth.body.error));
  assert.ok(!/device|authorization|bearer/i.test(wrongToken.body.error));
});

test("doğrulama başarılıysa sonraki handler req.deviceId'yi kullanabiliyor (upload meta'sında görünür)", async () => {
  const result = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "req-deviceid-testi.txt", content: "icerik" }],
    fields: { targetPath: "" },
    headers: server.authHeaders,
  });
  assert.equal(result.status, 200);

  const metaRaw = await readFile(
    path.join(server.storageRoot, "req-deviceid-testi.txt.meta.json"),
    "utf-8"
  );
  const meta = JSON.parse(metaRaw);
  assert.equal(meta.uploadedBy, server.deviceId);
});
