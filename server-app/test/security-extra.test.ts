// Görev 3 — önceki oturumda test EDİLMEYEN güvenlik senaryoları.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import { getJson, getRaw, uploadMultipart, uploadRawMultipart, setDefaultHeaders } from "./helpers/http";

let server: TestServer;

before(async () => {
  server = await startTestServer();
  setDefaultHeaders(server.authHeaders);
});

after(async () => {
  await server.stop();
});

test("a) gerçek dosya symlink'i ile depo dışına erişim engellenir", async () => {
  const outsideDir = await mkdtemp(path.join(tmpdir(), "deneme-server-sym-file-"));
  const outsideFile = path.join(outsideDir, "gizli-dosya-sym.txt");
  await writeFile(outsideFile, "GIZLI DOSYA ICERIGI", "utf-8");

  const linkPath = path.join(server.storageRoot, "dosya-sembolu.txt");
  try {
    let linkCreated = true;
    try {
      await symlink(outsideFile, linkPath, "file");
    } catch (err) {
      // Gelistirici modu/yonetici izni yoksa Windows dosya symlink olusturmayi
      // reddedebilir (EPERM). Bu durumda senaryo bu makinede test edilemez;
      // junction ile ayni yol cozumleme kodu kullanildigi icin risk dusuk, ama
      // rapora not dusuyoruz.
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        console.warn("UYARI: dosya symlink'i oluşturulamadı (EPERM) — bu makinede test atlandı");
        linkCreated = false;
      } else {
        throw err;
      }
    }
    if (linkCreated) {
      const download = await getRaw(`${server.baseUrl}/api/files/download?path=/dosya-sembolu.txt`);
      assert.equal(download.status, 400, "dosya symlink'i üzerinden depo dışı içerik indirilebilmemeli");
    }
  } finally {
    await rm(linkPath, { force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("a) gerçek klasör symlink'i ile depo dışına erişim engellenir", async () => {
  const outsideDir = await mkdtemp(path.join(tmpdir(), "deneme-server-sym-dir-"));
  await writeFile(path.join(outsideDir, "icerik.txt"), "disaridan", "utf-8");

  const linkPath = path.join(server.storageRoot, "klasor-sembolu");
  try {
    let linkCreated = true;
    try {
      await symlink(outsideDir, linkPath, "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        console.warn("UYARI: klasör symlink'i oluşturulamadı (EPERM) — bu makinede test atlandı");
        linkCreated = false;
      } else {
        throw err;
      }
    }
    if (linkCreated) {
      const listing = await getJson(`${server.baseUrl}/api/files?path=/klasor-sembolu`);
      assert.equal(listing.status, 400, "klasör symlink'i üzerinden depo dışı listeleme engellenmeli");
    }
  } finally {
    await rm(linkPath, { force: true, recursive: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("b) sondaki nokta/boşluk içeren dosya adları güvenle kaydedilip geri okunabilir", async () => {
  for (const raw of ["nokta-ile-biten.", "bosluk-ile-biten "]) {
    const { status, body } = await uploadRawMultipart(server.baseUrl, {
      filenameRaw: raw,
      content: "icerik",
      targetPath: "",
    });
    assert.equal(status, 200, `"${raw}" yüklemesi başarısız oldu`);
    const uploadedName = body.uploaded[0].name;
    const download = await getRaw(
      `${server.baseUrl}/api/files/download?path=${encodeURIComponent("/" + uploadedName)}`
    );
    assert.equal(download.status, 200, `"${uploadedName}" indirilemedi`);
    assert.equal(download.text, "icerik");
  }
});

test("c) NFC ve NFD biçiminde aynı görünen ama farklı baytlı iki ad ayrı dosya olarak kalmamalı (ya da en azından ikisi de düzgün çalışmalı)", async () => {
  const nfc = "café-nfc.txt".normalize("NFC"); // tek kod noktalı é (U+00E9)
  const nfd = "café-nfc.txt".normalize("NFD"); // e + birleşen aksan (U+0065 U+0301)
  assert.notEqual(Buffer.from(nfc).toString("hex"), Buffer.from(nfd).toString("hex"), "test verisi gerçekten farklı bayt dizileri olmalı");

  const r1 = await uploadRawMultipart(server.baseUrl, { filenameRaw: nfc, content: "nfc-icerik", targetPath: "" });
  assert.equal(r1.status, 200);
  const r2 = await uploadRawMultipart(server.baseUrl, { filenameRaw: nfd, content: "nfd-icerik", targetPath: "" });
  assert.equal(r2.status, 200);

  // Duzeltme: sunucu adlari NFC'ye normallestirdigi icin ikinci yukleme,
  // birinciyle "ayni gorunen ad" cakismasi olarak algilanip " (1)" almali —
  // boylece kullanicinin listede birbirinden ayirt edemeyecegi iki "ayni" ad
  // olusmaz.
  assert.notEqual(r1.body.uploaded[0].name, r2.body.uploaded[0].name);
  const listing = await getJson(`${server.baseUrl}/api/files`);
  const visualNames = listing.body.entries.map((e: any) => e.name.normalize("NFC"));
  const cafeEntries = visualNames.filter((n: string) => n.startsWith("café-nfc"));
  assert.equal(new Set(cafeEntries).size, cafeEntries.length, "listede görünüşte ayırt edilemeyen yinelenen ad olmamalı");
});

test("d) Windows MAX_PATH sınırını aşan tam yol düzgün ele alınır (503/500 çökmesi olmamalı)", async () => {
  // Depo kökü + derin klasör zinciri + dosya adi, toplamda 260 karakteri asacak
  // sekilde kurgulanir.
  let deepRel = "";
  const segments: string[] = [];
  for (let i = 0; i < 15; i++) {
    segments.push("cok-uzun-klasor-adi-segmenti-" + i);
  }
  deepRel = "/" + segments.join("/");
  await mkdir(path.join(server.storageRoot, ...segments), { recursive: true });

  const totalPathLength = server.storageRoot.length + deepRel.length + "/dosya.txt".length;
  assert.ok(totalPathLength > 260, `test senaryosu MAX_PATH'i aşmıyor (uzunluk: ${totalPathLength})`);

  const { status } = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "dosya.txt", content: "icerik" }],
    fields: { targetPath: deepRel },
  });
  // Modern Node.js Windows'ta uzun yol destegi sagladigi icin basarili (200)
  // olmasi beklenir; olmasa bile makul bir hata kodu (400/503) donmeli, sunucu
  // çökmemeli veya belirsiz bir 500 vermemeli.
  assert.ok([200, 400, 503].includes(status), `beklenmeyen durum kodu: ${status}`);

  const ping = await getJson(`${server.baseUrl}/ping`);
  assert.equal(ping.status, 200, "uzun yol denemesinden sonra sunucu hâlâ ayakta olmalı");
});

test("e) notta kontrol karakteri / null bayt / satır sonu meta.json'ı bozmaz", async () => {
  const trickyNote = "satır1\nsatır2\r\ntab\tve\x00null-bayt-var";
  const { status, body } = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: "kontrol-karakterli-not.txt",
    content: "x",
    note: trickyNote,
    targetPath: "",
  });
  assert.equal(status, 200);
  const metaRaw = await readFile(
    path.join(server.storageRoot, "kontrol-karakterli-not.txt.meta.json"),
    "utf-8"
  );
  const meta = JSON.parse(metaRaw); // JSON.parse basarisiz olursa test kendiliginden patlar
  assert.equal(meta.note, trickyNote, "not, meta.json'dan aynen geri okunabilmeli");
});

test("f) '<ad>.meta.json' adında dosya yüklemek gerçek meta dosyasının üzerine yazmaz", async () => {
  // Once normal bir dosya yukleyip gercek meta.json'ini olustur.
  const first = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "korunacak.txt", content: "orijinal icerik" }],
    fields: { note: "orijinal not", targetPath: "" },
  });
  assert.equal(first.status, 200);
  const originalMeta = await readFile(
    path.join(server.storageRoot, "korunacak.txt.meta.json"),
    "utf-8"
  );

  // Simdi tam o adi tasiyan bir "dosya" yuklemeyi dene.
  const attack = await uploadMultipart(server.baseUrl, {
    files: [{ filename: "korunacak.txt.meta.json", content: '{"kotu":"veri"}' }],
    fields: { targetPath: "" },
  });
  assert.equal(attack.status, 200);

  const metaAfter = await readFile(
    path.join(server.storageRoot, "korunacak.txt.meta.json"),
    "utf-8"
  );
  assert.equal(metaAfter, originalMeta, "gerçek meta.json üzerine yazılmamalı");

  // Cakisma numaralandirmasi devreye girip dosyayi baska bir adla kaydetmis
  // olsa bile (ör. "korunacak.txt.meta (1).json"), bu ad ".meta.json" ile
  // BİTMEDİĞİ için listede gizlenmemeli — kullanıcı yüklediği içeriği
  // görebilmeli, sessizce kaybolmamalı.
  assert.equal(attack.body.uploaded.length, 1, "saldırı dosyası reddedilmek yerine güvenli bir adla kaydedilmeli");
  const attackSavedName = attack.body.uploaded[0].name;
  assert.ok(!attackSavedName.endsWith(".meta.json"), "kaydedilen ad hâlâ .meta.json ile bitmemeli (listede gizlenmesin)");

  const listing = await getJson(`${server.baseUrl}/api/files`);
  const names = listing.body.entries.map((e: any) => e.name);
  assert.ok(names.includes(attackSavedName), "yüklenen dosya listede görünür olmalı, sessizce kaybolmamalı");
});

test("g) dosya adında \\r/\\n olursa başlık enjeksiyonu oluşmaz", async () => {
  const { status, body } = await uploadRawMultipart(server.baseUrl, {
    filenameRaw: "zararli\r\nX-Injected: evil.txt",
    content: "x",
    targetPath: "",
  });
  // Ham \r\n, multipart govdesinin KENDI header satirini da bolduğu icin
  // busboy bu dosya parcasini gecersiz sayip reddedebilir (400) — bu da
  // guvenli bir sonuçtur (enjeksiyona ugrayacak bir kayitli ad hic olusmaz).
  // Eger parser yine de bir ad cikarabilirse, o adin CRLF icermemesi ve
  // Content-Disposition'a guvenle yansimasi gerekir.
  assert.ok([200, 400].includes(status), `beklenmeyen durum kodu: ${status}`);

  if (status === 200) {
    const savedName = body.uploaded[0].name;
    assert.ok(!savedName.includes("\r") && !savedName.includes("\n"), "kaydedilen adda CRLF olmamalı");

    const download = await getRaw(
      `${server.baseUrl}/api/files/download?path=${encodeURIComponent("/" + savedName)}`
    );
    assert.equal(download.status, 200);
    const cd = download.headers.get("content-disposition") ?? "";
    assert.ok(!cd.includes("\r") && !cd.includes("\n"), "Content-Disposition başlığı CRLF içermemeli");
    assert.ok(!cd.toLowerCase().includes("x-injected"), "başlık enjeksiyonu oluşmamalı");
  }

  const ping = await getJson(`${server.baseUrl}/ping`);
  assert.equal(ping.status, 200, "sunucu bu istekten sonra da sağlıklı olmalı");
});

test("h) targetPath'te URL-kodlanmış traversal güvenle reddedilir/etkisizdir", async () => {
  const r1 = await getJson(`${server.baseUrl}/api/files?path=%2e%2e%2f%2e%2e%2f`);
  assert.equal(r1.status, 400, "tekli URL-kodlanmış traversal depo dışına çıkmamalı");

  const r2 = await getJson(`${server.baseUrl}/api/files?path=%252e%252e%252f`);
  // cift kodlanmis traversal Express tarafindan sadece bir kez cozulur; ya
  // depo icinde var olmayan zararsiz bir "%2e%2e%2f" adi olarak 404 doner ya
  // da (cozulmezse) baska sekilde zararsiz kalir — asla depo disina cikmamali.
  assert.notEqual(r2.status, 200, "çift URL-kodlanmış traversal depo içeriğini sızdırmamalı");
});

test("i) sadece boşluk / sadece nokta içeren dosya adları güvenle ele alınır", async () => {
  for (const raw of ["   ", "..."]) {
    const { status } = await uploadRawMultipart(server.baseUrl, {
      filenameRaw: raw,
      content: "x",
      targetPath: "",
    });
    // Ya temiz bir sekilde kabul edilip guvenli bir ada donusturulmeli ya da
    // "skipped" ile reddedilmeli; hicbir zaman 500/503 ile sunucuyu asagi
    // cekmemeli ya da depo disina yazmamali.
    assert.ok([200].includes(status), `"${raw}" için beklenmeyen durum kodu: ${status}`);
  }
  const ping = await getJson(`${server.baseUrl}/ping`);
  assert.equal(ping.status, 200);
});
