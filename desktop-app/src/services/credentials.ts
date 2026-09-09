/** mobildeki services/credentials.ts (expo-secure-store) karşılığı - Electron safeStorage, main process'te (bkz. electron/main/credentials.ts). */

export class InvalidCredentialsError extends Error {
  constructor(message = 'Geçersiz eşleştirme kodu') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

export type Credentials = { deviceId: string; token: string };

export async function saveCredentials(deviceId: string, token: string): Promise<void> {
  if (!deviceId || !token) throw new InvalidCredentialsError();
  await window.desktop.client.setCredentials(deviceId, token);
}

export async function getCredentials(): Promise<Credentials | null> {
  return window.desktop.client.getCredentials();
}
