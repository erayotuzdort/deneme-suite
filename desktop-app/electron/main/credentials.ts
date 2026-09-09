import { safeStorage } from 'electron';
import Store from 'electron-store';

/**
 * expo-secure-store'un masaüstü karşılığı: Electron'un yerleşik safeStorage
 * API'si (OS seviyesinde şifreleme - Windows'ta DPAPI). Ekstra native bağımlılık
 * (ör. keytar, native derleme gerektirir) yerine Electron'un kendi, sıfır ek
 * bağımlılıklı API'si tercih edildi.
 */
type StoredCredentials = { deviceId: string; tokenEncryptedBase64: string };

const credentialsStore = new Store<{ credentials: StoredCredentials | null }>({
  name: 'credentials',
  defaults: { credentials: null },
});

export function getStoredCredentials(): { deviceId: string; token: string } | null {
  const stored = credentialsStore.get('credentials');
  if (!stored || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const token = safeStorage.decryptString(Buffer.from(stored.tokenEncryptedBase64, 'base64'));
    return { deviceId: stored.deviceId, token };
  } catch {
    return null;
  }
}

export function setStoredCredentials(deviceId: string, token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Bu sistemde güvenli kimlik bilgisi depolama kullanılamıyor');
  }
  const tokenEncryptedBase64 = safeStorage.encryptString(token).toString('base64');
  credentialsStore.set('credentials', { deviceId, tokenEncryptedBase64 });
}

export function clearStoredCredentials(): void {
  credentialsStore.set('credentials', null);
}
