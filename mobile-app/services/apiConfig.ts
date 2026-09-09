import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE_URL_KEY = 'apiBaseUrl';

/** Ayarlanmış sunucu adresi, hiç eşleştirme yapılmadıysa null. */
export function getApiBaseUrl(): Promise<string | null> {
  return AsyncStorage.getItem(API_BASE_URL_KEY);
}

export async function setApiBaseUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(API_BASE_URL_KEY, url);
}
