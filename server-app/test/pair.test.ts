import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pairDevice } from "../src/pair";
import { verifyToken } from "../src/auth";

let testDir: string;
let tokensFile: string;
let devicesFile: string;

before(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), "deneme-server-pair-test-"));
  tokensFile = path.join(testDir, "tokens.json");
  devicesFile = path.join(testDir, "devices.json");
});

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function opts() {
  return { tokensFilePath: tokensFile, devicesFilePath: devicesFile };
}

test("pairDevice bir deviceId, token ve pairedAt döner", async () => {
  const result = await pairDevice("Test Cihazı", opts());
  assert.equal(result.name, "Test Cihazı");
  assert.match(result.deviceId, /^[0-9a-f-]{36}$/, "deviceId bir UUID olmalı");
  assert.match(result.token, /^[0-9a-f]{64}$/, "token 64 hex karakter olmalı");
  assert.equal(typeof result.pairedAt, "string");
});

test("dönen token, auth.verifyToken ile aynı tokens.json üzerinden doğrulanabilir", async () => {
  const result = await pairDevice("Doğrulama Testi", opts());
  const ok = await verifyToken(result.deviceId, result.token, tokensFile);
  assert.equal(ok, true);
});

test("devices.json'a cihaz kaydı doğru yazılır", async () => {
  const result = await pairDevice("Kayıt Testi", opts());
  const raw = await readFile(devicesFile, "utf-8");
  const parsed = JSON.parse(raw);

  assert.ok(parsed[result.deviceId], "devices.json'da bu deviceId için kayıt olmalı");
  assert.equal(parsed[result.deviceId].name, "Kayıt Testi");
  assert.equal(typeof parsed[result.deviceId].pairedAt, "string");
});

test("devices.json'da token/hash bulunmaz (sadece isim ve zaman)", async () => {
  const result = await pairDevice("Hassas Veri Testi", opts());
  const raw = await readFile(devicesFile, "utf-8");

  assert.ok(!raw.includes(result.token), "ham token devices.json'da bulunmamalı");
  const parsed = JSON.parse(raw);
  const keys = Object.keys(parsed[result.deviceId]).sort();
  assert.deepEqual(keys, ["name", "pairedAt"]);
});

test("aynı isimle iki kez eşleştirme iki farklı deviceId/token üretir", async () => {
  const a = await pairDevice("Tekrarlanan İsim", opts());
  const b = await pairDevice("Tekrarlanan İsim", opts());

  assert.notEqual(a.deviceId, b.deviceId);
  assert.notEqual(a.token, b.token);
  assert.equal(await verifyToken(a.deviceId, a.token, tokensFile), true);
  assert.equal(await verifyToken(b.deviceId, b.token, tokensFile), true);
});

test("boş ya da sadece boşluk içeren isim reddedilir", async () => {
  await assert.rejects(() => pairDevice("", opts()));
  await assert.rejects(() => pairDevice("   ", opts()));
});

test("isimdeki baştaki/sondaki boşluklar temizlenir", async () => {
  const result = await pairDevice("  Boşluklu İsim  ", opts());
  assert.equal(result.name, "Boşluklu İsim");
});

test("birden fazla cihaz eşleştirildiğinde devices.json'da hepsi birikir", async () => {
  const a = await pairDevice("Çoklu A", opts());
  const b = await pairDevice("Çoklu B", opts());
  const raw = await readFile(devicesFile, "utf-8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed[a.deviceId].name, "Çoklu A");
  assert.equal(parsed[b.deviceId].name, "Çoklu B");
});
