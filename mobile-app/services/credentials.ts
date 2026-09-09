import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'deviceId';
const TOKEN_KEY = 'authToken';

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

export type Credentials = { deviceId: string; token: string };

/** Eşleştirme sırasında yapıştırılan deviceId/token beklenen biçimde değil. */
export class InvalidCredentialsError extends Error {
  constructor(message = 'Eşleştirme verisi geçersiz') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

export async function saveCredentials(deviceId: string, token: string): Promise<void> {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new InvalidCredentialsError('Cihaz kimliği geçersiz biçimde');
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new InvalidCredentialsError('Token geçersiz biçimde');
  }
  await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function getCredentials(): Promise<Credentials | null> {
  const [deviceId, token] = await Promise.all([
    SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (!deviceId || !token) return null;
  return { deviceId, token };
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(DEVICE_ID_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);
}
