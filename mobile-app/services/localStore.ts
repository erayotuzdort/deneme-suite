/**
 * Ekranların/context'lerin kullanabileceği küçük, kalıcı anahtar-değer deposu.
 *
 * PLATFORMA ÖZEL: masaüstünde ayrı bir karşılığı var (deneme-desktop/src/
 * services/localStore.ts, localStorage tabanlı) ve vite.config.ts'te
 * '@/services/localStore' oraya alias'lanıyor. Bu katman olmadan ortak
 * context'ler kalıcı veri yazamıyordu - AsyncStorage yalnızca mobilde var,
 * masaüstünün node_modules'ünde bulunmuyor.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // Bozuk/okunamayan kayıt uygulamayı düşürmemeli - varsayılana dön.
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[localStore] Yazılamadı:', key, e);
  }
}
