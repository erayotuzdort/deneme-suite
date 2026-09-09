import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { broadcastToWindows } from './broadcast';

/**
 * Aktarım geçmişi (Bildirimler sekmesinin veri kaynağı).
 *
 * Bu kayıt BİLEREK sadece masaüstünde tutuluyor: gömülü sunucu bu makinede
 * çalıştığından gelen/giden tüm trafiği yalnızca burası eksiksiz görebilir
 * (telefon, kendisine ulaşamayan bir isteği zaten raporlayamaz). Telefon
 * tarafındaki Bildirimler ekranı DEĞİŞTİRİLMEDİ.
 *
 * Kalıcılık userData altında düz bir JSON dosyası - settings.ts'in
 * electron-store'u tercih edilmedi, çünkü bu liste sürekli büyüyen bir olay
 * akışı; ayarlarla aynı dosyada tutmak ayar okuma/yazmalarını gereksiz yere
 * ağırlaştırırdı.
 */

export type TransferDirection = 'incoming' | 'outgoing';
export type TransferStatus = 'success' | 'failed';

export type TransferRecord = {
  id: string;
  direction: TransferDirection;
  status: TransferStatus;
  fileName: string;
  path: string | null;
  sizeBytes: number | null;
  deviceId: string | null;
  /** Eşleştirme kaydından çözülen okunabilir cihaz adı (bulunamazsa null). */
  deviceName: string | null;
  at: string;
  error?: string;
  /** Dosyanın bu makinede nereye kaydedildiği (biliniyorsa). */
  savedPath?: string;
  unread: boolean;
};

/** Liste sınırsız büyümesin - en yeni bu kadar kayıt tutulur. */
const MAX_RECORDS = 500;

let records: TransferRecord[] = [];
let loaded = false;
/** Arka arkaya gelen olaylarda diski dövmemek için yazma işi geciktirilir. */
let saveTimer: NodeJS.Timeout | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), 'transfers.json');
}

/**
 * Diskten okunan bir kaydın gerçekten kayda benzediğini doğrular. Dosya elle
 * düzenlenmiş ya da eski bir sürümden kalmış olabilir; şekli bozuk bir kayıt
 * arayüze kadar gidip render sırasında patlamamalı.
 */
function isTransferRecord(value: unknown): value is TransferRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.at === 'string' &&
    typeof r.fileName === 'string' &&
    (r.direction === 'incoming' || r.direction === 'outgoing') &&
    (r.status === 'success' || r.status === 'failed')
  );
}

export async function loadTransfers(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(filePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    // MAX_RECORDS kırpması YÜKLEMEDE de uygulanmalı: eskiden yalnızca
    // addTransfer kırpıyordu, dolayısıyla 500'den uzun bir dosya (eski sürüm,
    // elle düzenleme) ilk yeni aktarım gelene kadar tamamen bellekte kalıyordu.
    records = Array.isArray(parsed) ? parsed.filter(isTransferRecord).slice(0, MAX_RECORDS) : [];
  } catch {
    // Dosya yoksa ya da bozuksa boş listeyle başla - geçmiş kaybı, uygulamanın
    // açılmamasından iyidir.
    records = [];
  }
}

async function writeNow(): Promise<void> {
  const snapshot = JSON.stringify(records, null, 2);
  try {
    await fs.writeFile(filePath(), snapshot, 'utf-8');
  } catch (err) {
    console.error('[transfers] kaydedilemedi:', err);
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeNow();
  }, 400);
}

/**
 * Bekleyen (geciktirilmiş) yazmayı hemen diske indirir. Kapanışta ÇAĞRILMASI
 * ŞART: aksi hâlde kapanmadan 400 ms önce kaydedilen aktarım kaybolur —
 * uygulama `app.exit()` ile aniden sonlandığından zamanlayıcı hiç çalışmaz.
 */
export async function flushTransfers(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!loaded) return;
  await writeNow();
}

function broadcast(): void {
  broadcastToWindows('transfers:changed');
}

function newId(): string {
  return `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function addTransfer(input: Omit<TransferRecord, 'id' | 'at' | 'unread'>): TransferRecord {
  const record: TransferRecord = { ...input, id: newId(), at: new Date().toISOString(), unread: true };
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  scheduleSave();
  broadcast();
  return record;
}

/** Yerel (IPC) tüketiciler için tam kayıt - savedPath dahil. */
export function listTransfers(): TransferRecord[] {
  return records;
}

/**
 * UZAK istemciler (GET /api/transfers üzerinden telefon vb.) için kayıt.
 *
 * `savedPath` bilerek çıkarılıyor: dosyanın BU makinedeki mutlak yolu
 * ("C:\Users\<kullanıcı>\Downloads\...") telefonun hiçbir işine yaramıyor
 * (o yola erişemez) ama Windows kullanıcı adını ve klasör düzenini eşleşmiş
 * her cihaza sızdırıyordu. Geri kalan alanlar (dosya adı, boyut, yön, cihaz
 * adı) geçmişin telefonda gösterilmesi için zaten gerekli.
 */
export function listTransfersForRemote(): Omit<TransferRecord, 'savedPath'>[] {
  return records.map(({ savedPath: _savedPath, ...rest }) => rest);
}

export function removeTransfers(ids: string[]): void {
  const doomed = new Set(ids);
  const before = records.length;
  records = records.filter((r) => !doomed.has(r.id));
  if (records.length === before) return;
  scheduleSave();
  broadcast();
}

export function clearTransfers(): void {
  if (records.length === 0) return;
  records = [];
  scheduleSave();
  broadcast();
}

export function markTransfersRead(ids: string[]): void {
  const target = new Set(ids);
  let changed = false;
  records = records.map((r) => {
    if (!target.has(r.id) || !r.unread) return r;
    changed = true;
    return { ...r, unread: false };
  });
  if (!changed) return;
  scheduleSave();
  broadcast();
}
