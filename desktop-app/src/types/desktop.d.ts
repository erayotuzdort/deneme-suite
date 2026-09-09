import type { DesktopApi, TransferRecord as PreloadTransferRecord } from '../../electron/preload/index';

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

/** Bildirimler ekranının kullandığı aktarım kaydı — preload'daki tipin yeniden ihracı. */
export type TransferRecord = PreloadTransferRecord;
