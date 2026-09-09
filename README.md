# deneme

Kişisel dosya aktarım sistemi: telefonunla ev bilgisayarın arasında, kapalı bir
özel ağ (Tailscale) üzerinden dosya gönderip alırsın. Bulut yok, aracı sunucu
yok — dosyalar yalnızca kendi cihazlarının arasında dolaşır.

Sistem üç parçadan oluşuyor. Her parça kendi klasöründe, kendi `package.json`
dosyasıyla duruyor ve ayrı ayrı kurulur.

| Klasör | Ne işe yarar | Durum |
|---|---|---|
| [`mobile-app/`](mobile-app) | Telefon uygulaması (Android, Expo) | ✅ Bu depoda |
| [`server-app/`](server-app) | Dosya sunucusu (Node + Express) | ✅ Bu depoda |
| [`desktop-app/`](desktop-app) | Masaüstü uygulaması (Windows, Electron) | ✅ Bu depoda |

## Parçalar birbirine nasıl bağlı

`desktop-app` tek başına derlenmez — iki kardeşine birden bağlıdır:

- **`server-app`**: masaüstü, sunucuyu ayrı bir süreç olarak değil, kendi
  Electron ana sürecinin İÇİNDE çalıştırır (`file:../server-app` bağımlılığı).
- **`mobile-app`**: Dosyalar ve Aktarım sekmeleri, telefon uygulamasının
  ekranlarının ta kendisidir — `react-native-web` ile çizilir, kopyalanmaz.

Bu yüzden **kurulum sırası önemli**:

```bash
git clone https://github.com/erayotuzdort/deneme-suite.git
cd deneme-suite

cd mobile-app  && npm install && cd ..   # masaüstünün tipleri buna bağlı
cd server-app  && npm install && npm run build && cd ..   # dist/ üretmeli
cd desktop-app && npm install            # server-app/dist'i kendi içine kopyalar
```

`server-app` derlenmemişse `desktop-app`'in kurulumu net bir hatayla durur.

## mobile-app

Telefondan sunucuya dosya yükler, sunucudaki dosyaları listeler ve indirir.
Aktarım geçmişini (gelen, giden ve başarısız olanlar) gösterir.

**Gereksinimler:** Node.js 20+, [Expo](https://docs.expo.dev/) ve Android
cihaz/emülatör.

```bash
cd mobile-app
npm install
npx expo start
```

Gerçek cihaza kurmak için bir APK gerekiyor:

```bash
npx eas login      # kendi Expo hesabın
npx eas init       # bu kopyayı kendi Expo projene bağlar
npx eas build --profile preview --platform android
```

> `eas init` adımı gerekli: depoda hiçbir Expo proje kimliği tutulmuyor, herkes
> kendi hesabına bağlar.

### İlk kurulum

1. Bilgisayarda `desktop-app`'i aç ve **Sunucu** sekmesinden bir depo klasörü
   seçip sunucuyu başlat
2. Aynı sekmede **+** ile bir cihaz eşleştirmesi oluştur — sana `deviceId` ve
   `token` içeren bir JSON verir. Kartta bu bilgisayarın Tailscale adresi de
   yazar (örn. `http://100.64.0.1:4000`)
3. Telefonda **Cihazı Eşleştir** ekranına o JSON'u yapıştır
4. **Sunucu Adresi** ekranına kartta yazan adresi gir

## server-app

Depo klasörünü HTTP üzerinden listeleyen, indiren ve üzerine yazan sunucu.
Masaüstü uygulaması bunu gömülü olarak çalıştırır; ayrıca tek başına (CLI)
da çalışabilir. Ayrıntılar: [`server-app/README.md`](server-app/README.md).

```bash
cd server-app
npm install
npm run build
```

## desktop-app

Windows masaüstü uygulaması: gömülü sunucuyu yönetir (başlat/durdur, depo
klasörü, port, cihaz eşleştirme) ve aynı zamanda bir istemcidir — dosya
gönderir, indirir, aktarım geçmişini tutar.

```bash
cd desktop-app
npm install
npm run typecheck
npm run dev       # geliştirme
npm run package   # Windows kurulum dosyası (release/)
```

> Kurulum dosyası **imzasız** olduğu için Windows SmartScreen bir uyarı
> gösterir: "Daha fazla bilgi" → "Yine de çalıştır".

### Neden düz HTTP?

Uygulama sunucuya `http://` ile bağlanıyor. Şifrelemeyi taşıyan katman
Tailscale'in WireGuard tüneli; trafik zaten cihazların arasından çıkmıyor.
Android 9'dan beri TLS'siz trafik varsayılan olarak engellendiği için
`plugins/withCleartextTraffic.js` bu izni açıyor.

## Lisans

Kişisel bir proje; dilediğin gibi kullanabilirsin.
