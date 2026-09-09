import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateToken, verifyToken } from "../src/auth";

let testDir: string;
let tokensFile: string;

before(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), "deneme-server-auth-test-"));
  tokensFile = path.join(testDir, "tokens.json");
});

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("generateToken 32 baytlık (64 hex karakter) bir token döner", async () => {
  const token = await generateToken("cihaz-a", tokensFile);
  assert.equal(typeof token, "string");
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test("aynı token doğru cihaz ile doğrulanır", async () => {
  const token = await generateToken("cihaz-b", tokensFile);
  const ok = await verifyToken("cihaz-b", token, tokensFile);
  assert.equal(ok, true);
});

test("yanlış token reddedilir", async () => {
  await generateToken("cihaz-c", tokensFile);
  const ok = await verifyToken("cihaz-c", "yanlis-token-buraya-64-karakter-olmasa-da-guvenli-sekilde-reddedilmeli", tokensFile);
  assert.equal(ok, false);
});

test("olmayan cihaz için doğrulama false döner", async () => {
  const ok = await verifyToken("hic-boyle-bir-cihaz-yok", "herhangi-bir-token", tokensFile);
  assert.equal(ok, false);
});

test("tokens dosyası hiç yokken verifyToken hata fırlatmadan false döner", async () => {
  const bosDosya = path.join(testDir, "olmayan-tokens.json");
  const ok = await verifyToken("cihaz-x", "herhangi-bir-token", bosDosya);
  assert.equal(ok, false);
});

test("aynı cihaz için yeniden üretim eski token'ı geçersiz kılar", async () => {
  const eskiToken = await generateToken("cihaz-d", tokensFile);
  const yeniToken = await generateToken("cihaz-d", tokensFile);

  assert.notEqual(eskiToken, yeniToken, "her üretim farklı, rastgele bir token vermeli");
  assert.equal(await verifyToken("cihaz-d", eskiToken, tokensFile), false, "eski token artık geçersiz olmalı");
  assert.equal(await verifyToken("cihaz-d", yeniToken, tokensFile), true, "yeni token geçerli olmalı");
});

test("farklı cihazların token'ları birbirini doğrulamaz", async () => {
  const tokenE = await generateToken("cihaz-e", tokensFile);
  const tokenF = await generateToken("cihaz-f", tokensFile);

  assert.equal(await verifyToken("cihaz-e", tokenF, tokensFile), false);
  assert.equal(await verifyToken("cihaz-f", tokenE, tokensFile), false);
  assert.equal(await verifyToken("cihaz-e", tokenE, tokensFile), true);
  assert.equal(await verifyToken("cihaz-f", tokenF, tokensFile), true);
});

test("diskte token'ın kendisi değil, sadece hash'i tutulur", async () => {
  const token = await generateToken("cihaz-g", tokensFile);
  const raw = await readFile(tokensFile, "utf-8");

  assert.ok(!raw.includes(token), "ham token dosyada düz metin olarak bulunmamalı");

  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed["cihaz-g"].tokenHash, "string");
  assert.match(parsed["cihaz-g"].tokenHash, /^[0-9a-f]{64}$/, "sha256 hash 64 hex karakter olmalı");
  assert.equal(typeof parsed["cihaz-g"].createdAt, "string");
});

test("deviceId boşsa generateToken hata fırlatır", async () => {
  await assert.rejects(() => generateToken("", tokensFile));
});

test("deviceId ya da token boşsa verifyToken false döner (hata fırlatmaz)", async () => {
  await generateToken("cihaz-h", tokensFile);
  assert.equal(await verifyToken("", "bir-token", tokensFile), false);
  assert.equal(await verifyToken("cihaz-h", "", tokensFile), false);
});
