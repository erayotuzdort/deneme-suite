import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/server";
import { getJson, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
});

after(async () => {
  await server.stop();
});

test("GET /ping ok:true ve zaman damgası döner (auth gerekmez)", async () => {
  // Kasıtlı olarak headers: null — /ping'in kimlik doğrulama olmadan da
  // çalıştığını doğrular (requireAuth bu uç noktaya uygulanmıyor).
  const { status, body } = await getJson(`${server.baseUrl}/ping`, null);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.server, "string");
  assert.equal(typeof body.timestamp, "string");
});

test("GET /api/devices kimlik doğrulama olmadan 401 döner", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/devices`, null);
  assert.equal(status, 401);
  assert.equal(body.ok, false);
});

test("GET /api/devices geçerli kimlik doğrulamayla çalışır", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/devices`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.devices));

  // helpers/server.ts, sunucuyu ayağa kaldırırken varsayılan test cihazını
  // hem tokens.json'a (auth) hem devices.json'a (isim/pairedAt) yazıyor —
  // burada görünmesi gerekir.
  const self = body.devices.find((d: any) => d.deviceId === server.deviceId);
  assert.ok(self, "varsayılan test cihazı listede olmalı");
  assert.equal(self.name, "Test Cihazı");
  assert.equal(typeof self.pairedAt, "string");
  assert.equal(typeof self.connected, "boolean");
});
