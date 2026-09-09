import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { getJson, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
  const root = server.storageRoot;
  await writeFile(path.join(root, "kok-dosya.txt"), "kok icerik", "utf-8");
  await writeFile(path.join(root, "kok-dosya.txt.meta.json"), "{}", "utf-8");
  await writeFile(path.join(root, ".gizli-dosya"), "gizli", "utf-8");
  await mkdir(path.join(root, "altklasor"), { recursive: true });
  await writeFile(path.join(root, "altklasor", "ic-dosya.txt"), "ic icerik", "utf-8");
  await mkdir(path.join(root, "bosklasor"), { recursive: true });
  await mkdir(path.join(root, "a", "b", "c"), { recursive: true });
  await writeFile(path.join(root, "a", "b", "c", "derin.txt"), "derin", "utf-8");
});

after(async () => {
  await server.stop();
});

test("kök klasör listelenir, meta ve gizli dosyalar görünmez", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files`);
  assert.equal(status, 200);
  const names = body.entries.map((e: any) => e.name);
  assert.ok(names.includes("kok-dosya.txt"));
  assert.ok(names.includes("altklasor"));
  assert.ok(!names.includes("kok-dosya.txt.meta.json"));
  assert.ok(!names.includes(".gizli-dosya"));
});

test("alt klasör listelenir", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files?path=/altklasor`);
  assert.equal(status, 200);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].name, "ic-dosya.txt");
});

test("iç içe klasör listelenir", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files?path=/a/b/c`);
  assert.equal(status, 200);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].name, "derin.txt");
});

test("boş klasör boş dizi döner", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files?path=/bosklasor`);
  assert.equal(status, 200);
  assert.deepEqual(body.entries, []);
});

test("olmayan klasör 404 döner", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files?path=/yok-boyle`);
  assert.equal(status, 404);
  assert.equal(body.ok, false);
});

test("dosya path olarak verilirse 400 döner", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files?path=/kok-dosya.txt`);
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test("depo dışına çıkan yol 400 döner", async () => {
  const { status, body } = await getJson(`${server.baseUrl}/api/files?path=/../../`);
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});
