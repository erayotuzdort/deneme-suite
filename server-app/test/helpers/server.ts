import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateToken } from "../../src/auth";

// cmd.exe /c npx tsx ... zinciri en az 3 sureç uretir (cmd -> npx -> node).
// child.kill() sadece en usttekini (cmd.exe) durdurur, gercek node.exe surecini
// yetim birakir. Windows'ta taskkill /T ile butun sureç agacini kapatiyoruz.
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(pid);
    } catch {
      // sureç zaten kapanmis olabilir
    }
  }
}

const DEFAULT_TEST_DEVICE_ID = "test-cihazi";

export type TestServer = {
  baseUrl: string;
  storageRoot: string;
  /** Bu sunucu sürecinin okuduğu, testler için izole geçici tokens.json yolu. */
  tokensFilePath: string;
  /** Bu sunucu sürecinin okuduğu, testler için izole geçici devices.json yolu. */
  devicesFilePath: string;
  /** Sunucu ayağa kalkarken otomatik eşleştirilen varsayılan test cihazının kimliği. */
  deviceId: string;
  /** { "X-Device-Id", "Authorization" } — bu sunucuya karşı yetkili istek atmak için hazır header'lar. */
  authHeaders: Record<string, string>;
  stop: () => Promise<void>;
};

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

async function pingOk(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/ping`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForPing(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pingOk(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

// Testler icin izole, disaridan-tamamen-ayri bir depo klasoru (proje disinda,
// isletim sisteminin gecici klasorunde), ayrı bir gecici tokens.json ve
// rastgele bir port kullanarak gercek sunucu surecini baslatir. Boylece
// testler gercek STORAGE_ROOT'a (E:\deneme-storage) ve gercek tokens.json'a
// asla dokunmaz. Port cakismasi ihtimaline karsi birkac kez farkli portla dener.
export async function startTestServer(): Promise<TestServer> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "deneme-server-test-"));
  const tokensFilePath = path.join(tmpdir(), `deneme-server-test-tokens-${randomBytes(8).toString("hex")}.json`);
  const devicesFilePath = path.join(tmpdir(), `deneme-server-test-devices-${randomBytes(8).toString("hex")}.json`);

  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = randomPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const env = {
      ...process.env,
      STORAGE_ROOT: storageRoot,
      PORT: String(port),
      HOST: "127.0.0.1",
      TOKENS_FILE: tokensFilePath,
      DEVICES_FILE: devicesFilePath,
    };

    // Windows'ta npx bir .cmd dosyasidir; spawn() bunu shell olmadan dogrudan
    // calistiramaz (EINVAL/ENOENT verir). cmd.exe /c ile sarmalamak en guvenilir yol.
    const child: ChildProcess =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/c", "npx", "tsx", "src/index.ts"], {
            cwd: PROJECT_ROOT,
            env,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn("npx", ["tsx", "src/index.ts"], {
            cwd: PROJECT_ROOT,
            env,
            stdio: "ignore",
          });

    const up = await waitForPing(baseUrl, 8000);
    if (up) {
      // Sunucu, kendi gecici tokens.json'ini TOKENS_FILE uzerinden okuyor;
      // ayni dosyaya burada (test surecinde) dogrudan yazmak, sunucuyu hic
      // yeniden baslatmadan gecerli kabul edilmesini sagliyor.
      const token = await generateToken(DEFAULT_TEST_DEVICE_ID, tokensFilePath);
      const authHeaders = { "X-Device-Id": DEFAULT_TEST_DEVICE_ID, Authorization: `Bearer ${token}` };
      // Sunucu, kendi gecici devices.json'ini DEVICES_FILE uzerinden okuyor;
      // varsayilan test cihazi icin de (tokens.json'daki gibi) bir kayit
      // yaziyoruz ki GET /api/devices bu cihazi isim/pairedAt ile donsun.
      await writeFile(
        devicesFilePath,
        JSON.stringify({ [DEFAULT_TEST_DEVICE_ID]: { name: "Test Cihazı", pairedAt: new Date().toISOString() } }, null, 2),
        "utf-8"
      );

      return {
        baseUrl,
        storageRoot,
        tokensFilePath,
        devicesFilePath,
        deviceId: DEFAULT_TEST_DEVICE_ID,
        authHeaders,
        stop: async () => {
          killTree(child.pid);
          await new Promise((r) => setTimeout(r, 300));
          // Windows'ta bir sureç az once kapandiginda, kullandigi klasoru siyah
          // hemen silmeye calismak EBUSY/ENOTEMPTY ile basarisiz olabilir (OS'un
          // handle'i serbest birakmasi biraz gecikebilir). fs.rm'nin kendi
          // maxRetries/retryDelay mekanizmasi bunu dogru sekilde bekleyip tekrar dener.
          await rm(storageRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
          await rm(tokensFilePath, { force: true, maxRetries: 8, retryDelay: 300 });
          await rm(devicesFilePath, { force: true, maxRetries: 8, retryDelay: 300 });
        },
      };
    }

    killTree(child.pid);
    await new Promise((r) => setTimeout(r, 100));
  }

  await rm(storageRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  await rm(tokensFilePath, { force: true, maxRetries: 8, retryDelay: 300 });
  await rm(devicesFilePath, { force: true, maxRetries: 8, retryDelay: 300 });
  throw new Error("Test sunucusu birden fazla denemede de ayağa kalkmadı");
}
