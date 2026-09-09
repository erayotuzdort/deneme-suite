/**
 * mobildeki services/localStore.ts (AsyncStorage) karşılığı.
 *
 * Renderer gerçek bir tarayıcı bağlamı olduğu için localStorage yeterli:
 * uygulama yeniden başlatıldığında kalıcı, senkron ve main process'e IPC
 * gerektirmiyor. Burada tutulan tek şey kullanıcının YEREL görünüm tercihi
 * (ör. kapattığı bildirimler); gerçek veri sunucuda duruyor, bu yüzden
 * kaybolması durumunda en fazla kapatılmış kayıtlar geri gelir.
 */
export async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[localStore] Yazılamadı:', key, e);
  }
}
