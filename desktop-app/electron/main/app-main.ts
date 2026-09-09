import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpcHandlers } from './ipc';
import { loadTransfers, flushTransfers } from './transfers';
import { autoStartIfNeeded, stopServer } from './server';
import { settings } from './settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Windows'ta bir tekilleştirme kilidi yok. deneme-server dosya sistemi üzerinde
// kilit kullanmadığından iki eşzamanlı sunucu instance'ı veri bozulmasına yol
// açabilir (özellikle .tmp-uploads temizliği) - bu yüzden ikinci bir örnek
// açılmaya çalışılırsa mevcut pencereye odaklanıp kendini kapatıyoruz.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

process.env.APP_ROOT = path.join(__dirname, '..', '..');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

/**
 * Sayfanın hiç yüklenememesi (boş beyaz pencere) kullanıcı için sessiz bir
 * hata; paketlenmiş uygulamada açılabilecek bir DevTools konsolu da yok.
 * Bu yüzden SADECE gerçek yükleme hatası userData altındaki bir dosyaya
 * yazılıyor. ('console-message' dinleyicisi kaldırıldı: kök neden çözüldü,
 * her renderer log satırını diske yazmanın bir faydası kalmamıştı ve
 * Electron 38'de o imza artık kullanımdan kalkmış, çalışma anında uyarı
 * basıyordu.)
 */
function logLoadFailure(line: string): void {
  try {
    const logPath = path.join(app.getPath('userData'), 'render-debug.log');
    appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
  } catch {
    // en son çare bir teşhis aracı - kendisi başarısız olursa sessizce yut
  }
}

function resolveIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(process.env.APP_ROOT as string, 'build', 'icon.png');
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Tray'den "Çıkış" seçilmeden sıradan pencere kapatma sadece simge durumuna küçültür. */
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    icon: resolveIconPath(),
    title: 'deneme',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    // Pencere kapatılınca uygulama tamamen çıkmasın - sunucu arka planda
    // çalışmaya devam etsin (mobilin foreground service'inin masaüstü
    // karşılığı). Tray ikonundan "Aç" ile geri getirilebilir.
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logLoadFailure(
      `did-fail-load errorCode=${errorCode} errorDescription="${errorDescription}" validatedURL="${validatedURL}"`
    );
  });

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resolveIconPath()).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('deneme');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Aç',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: 'Kapat (arka planda çalışmaya devam eder)',
      click: () => mainWindow?.hide(),
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  registerIpcHandlers();
  // Aktarım geçmişi diskten okunur - sunucu (ve dolayısıyla ilk olay) bundan
  // sonra başladığından, kayıtlı geçmişin üzerine yazma riski yok.
  await loadTransfers();
  // Kayıtlı autoLaunch ayarını, kullanıcı OS'ten elle değiştirmiş olsa bile
  // uygulamanın kendi kaydıyla senkron tut.
  app.setLoginItemSettings({ openAtLogin: settings.get('autoLaunch') });

  createWindow();
  createTray();
  await autoStartIfNeeded();
});

app.on('window-all-closed', () => {
  // macOS geleneği burada uygulanmıyor (Windows hedefleniyor) - ama pencereler
  // zaten "close" olayında hide ile engellendiğinden bu genelde tetiklenmez;
  // yine de tray'siz bir duruma düşülürse uygulamanın sessizce takılı
  // kalmaması için burada hiçbir şey yapmıyoruz (tray zaten uygulamayı canlı
  // tutuyor).
});

app.on('before-quit', () => {
  isQuitting = true;
});

/** Çıkış hiçbir koşulda bu süreden uzun sürmemeli (bkz. aşağıdaki not). */
const QUIT_TIMEOUT_MS = 5000;

app.on('will-quit', (event) => {
  event.preventDefault();
  // Kapanış işi bir zaman sınırıyla yarıştırılıyor. stopServer() açık
  // bağlantılar yüzünden gecikebiliyordu (artık kendi 3 sn'lik sınırı var,
  // ama burası son savunma hattı): sınırsız beklendiğinde app.exit() hiç
  // çalışmıyor ve uygulama tepsiden "Çıkış" seçilse bile kapanmıyor,
  // Görev Yöneticisi'nde asılı kalıyordu.
  const shutdown = (async () => {
    // Bekleyen aktarım kaydını diske indir - app.exit() zamanlayıcıları
    // çalıştırmadan süreci sonlandırdığından, geciktirilmiş yazma burada
    // flush edilmezse son kayıt kaybolur. Sunucudan ÖNCE yapılıyor ki
    // sunucu kapanışı gecikse bile kayıt kesin diske inmiş olsun.
    await flushTransfers();
    await stopServer();
  })();

  const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS));

  void Promise.race([shutdown.catch(() => {}), deadline]).then(() => app.exit());
});
