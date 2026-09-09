/** mobildeki services/apiConfig.ts (AsyncStorage) karşılığı - electron-store, main process'te (bkz. electron/main/settings.ts).
 *
 * Manuel bir adres girilmemişse bu bilgisayarın KENDİ gömülü sunucusuna
 * (http://localhost:<port>) varsayılan olarak bağlanır - "Sunucu Adresi"
 * modalı hâlâ manuel override (ör. uzak bir Tailscale adresi) için UI'da
 * duruyor ama artık zorunlu bir ilk adım değil. AYNI varsayılan
 * electron/main/client.ts'te de uygulanıyor - gerçek ağ istekleri oradan
 * (main process) atılıyor, buradan değil (bkz. o dosyanın başındaki not);
 * ikisi ayrı ayrı güncellenmezse burası sadece "Sunucu Adresi" modalının
 * gösterdiği değeri etkiler, gerçek isteklerin önündeki engeli değil. */
export async function getApiBaseUrl(): Promise<string | null> {
  const manual = await window.desktop.client.getServerAddress();
  if (manual) return manual;
  const { port } = await window.desktop.settings.get();
  return `http://localhost:${port}`;
}

export async function setApiBaseUrl(url: string): Promise<void> {
  await window.desktop.client.setServerAddress(url);
}
