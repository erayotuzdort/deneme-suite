/**
 * RENK KARARI (kullanıcı isteği):
 * - Koyu tema: marka kırmızısı TAM #ff0000, uyarı/hata rengi CANLI YEŞİL (#00e676).
 * - Açık tema: aynı kimlik, ama beyaz zeminde okunabilir tonlar — kırmızı #d10000,
 *   yeşil #00803f. Açık tema eskiden MAVİ markalıydı, artık iki tema da kırmızı.
 *
 * Neden açık temada tonlar farklı: ölçüldü, #ff0000 beyaz kart üzerinde 4,00:1 ve
 * canlı yeşil 1,67:1 — ikisi de AA eşiğinin (4,5) altında, güneş altında okunmuyor.
 * Koyu zeminde ikisi de rahat geçiyor, o yüzden koyu tema birebir istenen renklerde.
 *
 * accent / accentText ayrımı korunuyor: dolgu zemini ile metin rolü farklı tonlar
 * gerektirebiliyor (açık temada accent dolgu olarak beyaz yazı taşıyor).
 *
 * TEK BİLİNEN SAPMA: koyu temada #ff0000, satır zemini #1a1d22 üzerinde 4,23:1 —
 * AA eşiğinin hemen altında. Bilinçli: tam kırmızı açıkça istendi.
 *
 * Shared color palette for the app's custom screens (Bildirimler, Dosyalar, Aktarım).
 * A single source of truth so every screen stays visually consistent when the
 * dark/light theme is toggled from any of them.
 */

export type AppTheme = {
  bg: string;
  surface: string;
  border: string;
  dashed: string;
  inputBg: string;
  text: string;
  muted: string;
  dim: string;
  accent: string;
  /** Vurgu renginin METİN/İKON olarak güvenli sürümü — bkz. aşağıdaki not. */
  accentText: string;
  accentSoft: string;
  accentDeep: string;
  icon: string;
  track: string;
  ringLine: string;
  scrim: string;
  onAccent: string;
  toastBg: string;
  toastText: string;
  toastSub: string;
  toastAction: string;
  rowBg: string;
  rowBgSel: string;
  rowBorder: string;
  checkOff: string;
  helperOk: string;
  helperWarn: string;
  /** Yıkıcı eylem zemini (kaydırarak sil) — üstünde onAccent taşır. */
  danger: string;
  badge: readonly string[];
  btnIdle: string;
  btnIdleFg: string;
  btnIdleBorder: string;
};

const dark: AppTheme = {
  bg: '#0b0b0c',
  surface: '#15171b',
  border: '#242427',
  dashed: '#34373f',
  inputBg: '#101216',
  text: '#f2f3f5',
  muted: '#a0a3ad',
  dim: '#8d919c',
  accent: '#ff0000',
  accentText: '#ff0000',
  accentSoft: '#2e0a0a',
  accentDeep: '#b30000',
  icon: '#ff0000',
  track: '#242427',
  ringLine: '#2c2f36',
  scrim: 'rgba(4,5,7,0.6)',
  onAccent: '#ffffff',
  toastBg: '#141518',
  toastText: '#ffffff',
  toastSub: '#c3c7d0',
  toastAction: '#ff0000',
  rowBg: '#1a1d22',
  rowBgSel: '#2a0f0f',
  rowBorder: '#2c2f36',
  checkOff: '#41454e',
  helperOk: '#00e676',
  helperWarn: '#00e676',
  danger: '#ff0000',
  badge: ['#ff0000', '#4a4e57', '#5b6070', '#b30000', '#ff0000'],
  btnIdle: '#2a2d34',
  btnIdleFg: '#f2f3f5',
  btnIdleBorder: 'transparent',
};

const light: AppTheme = {
  bg: '#f3f5f8',
  surface: '#ffffff',
  border: '#e5e9ef',
  dashed: '#d3d7e0',
  inputBg: '#f7f8fa',
  text: '#12151c',
  muted: '#5d6675',
  dim: '#67707f',
  accent: '#d10000',
  accentText: '#d10000',
  accentSoft: '#fdecec',
  accentDeep: '#a30000',
  icon: '#d10000',
  track: '#e2e4ea',
  ringLine: '#dfe2e9',
  scrim: 'rgba(18,20,24,0.28)',
  onAccent: '#ffffff',
  toastBg: '#ffffff',
  toastText: '#14161a',
  toastSub: '#5d6675',
  toastAction: '#d10000',
  rowBg: '#ffffff',
  rowBgSel: '#fff1f1',
  rowBorder: '#eceef2',
  checkOff: '#d8dbe3',
  helperOk: '#00803f',
  helperWarn: '#00803f',
  danger: '#c50000',
  badge: ['#d10000', '#4a4e57', '#5b6070', '#8b0000', '#d10000'],
  btnIdle: '#ffffff',
  btnIdleFg: '#14161a',
  btnIdleBorder: '#dfe2e9',
};

export const APP_PALETTES = { dark, light };

export function getAppTheme(isDark: boolean): AppTheme {
  return isDark ? APP_PALETTES.dark : APP_PALETTES.light;
}
