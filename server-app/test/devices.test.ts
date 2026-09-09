import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer, type TestServer } from "./helpers/server";
import { getJson, deleteRequest, setDefaultHeaders } from "./helpers/http";
import { pairDevice } from "../src/pair";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
});

after(async () => {
  await server.stop();
});

function pairTestDevice(name: string) {
  return pairDevice(name, {
    tokensFilePath: server.tokensFilePath,
    devicesFilePath: server.devicesFilePath,
  });
}

test("DELETE /api/devices/:deviceId kimlik doğrulama olmadan 401 döner", async () => {
  const { status, body } = await deleteRequest(`${server.baseUrl}/api/devices/${randomUUID()}`, null);
  assert.equal(status, 401);
  assert.equal(body.ok, false);
});

test("DELETE /api/devices/:deviceId geçersiz biçimli id 400 döner", async () => {
  const { status, body } = await deleteRequest(`${server.baseUrl}/api/devices/not-a-uuid`);
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test("DELETE /api/devices/:deviceId var olmayan (ama biçimi geçerli) cihaz 404 döner", async () => {
  const { status, body } = await deleteRequest(`${server.baseUrl}/api/devices/${randomUUID()}`);
  assert.equal(status, 404);
  assert.equal(body.ok, false);
});

test("DELETE /api/devices/:deviceId cihazı devices.json'dan siler ve token'ını geçersiz kılar (sahiplik kontrolü yok)", async () => {
  const target = await pairTestDevice("Silinecek Cihaz");

  // Varsayılan test cihazı (A), hiçbir "sahiplik" ilişkisi olmayan target'ı (B) çıkarıyor.
  const del = await deleteRequest(`${server.baseUrl}/api/devices/${target.deviceId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  const list = await getJson(`${server.baseUrl}/api/devices`);
  assert.ok(
    !list.body.devices.some((d: any) => d.deviceId === target.deviceId),
    "silinen cihaz listede görünmemeli"
  );

  // target'ın token'ı da geçersiz kılınmış olmalı.
  const asTarget = await getJson(`${server.baseUrl}/api/devices`, {
    "X-Device-Id": target.deviceId,
    Authorization: `Bearer ${target.token}`,
  });
  assert.equal(asTarget.status, 401);
});

test("DELETE /api/devices/:deviceId aynı cihazı iki kez silmek ikinci seferde 404 döner", async () => {
  const target = await pairTestDevice("İki Kez Silinen");

  const first = await deleteRequest(`${server.baseUrl}/api/devices/${target.deviceId}`);
  assert.equal(first.status, 200);

  const second = await deleteRequest(`${server.baseUrl}/api/devices/${target.deviceId}`);
  assert.equal(second.status, 404);
});

test("DELETE /api/devices/:deviceId bir cihaz kendi kendini çıkarabilir (sahiplik/hiyerarşi yok)", async () => {
  const self = await pairTestDevice("Kendini Çıkaran Cihaz");
  const selfHeaders = { "X-Device-Id": self.deviceId, Authorization: `Bearer ${self.token}` };

  const del = await deleteRequest(`${server.baseUrl}/api/devices/${self.deviceId}`, selfHeaders);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  // Token artık geçersiz — aynı cihaz bir sonraki istekte 401 alır.
  const after = await getJson(`${server.baseUrl}/api/devices`, selfHeaders);
  assert.equal(after.status, 401);
});
