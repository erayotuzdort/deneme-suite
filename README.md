# deneme

Kişisel dosya aktarım sistemi: telefonunla ev bilgisayarın arasında, kapalı bir
özel ağ (Tailscale) üzerinden dosya gönderip alırsın. Bulut yok, aracı sunucu
yok — dosyalar yalnızca kendi cihazlarının arasında dolaşır.

Sistem üç parçadan oluşuyor. Her parça kendi klasöründe, kendi `package.json`
dosyasıyla duruyor ve ayrı ayrı kurulur.

| Klasör | Ne işe yarar | Durum |
|---|---|---|
| [`mobile-app/`](mobile-app) | Telefon uygulaması (Android, Expo) | ✅ Bu depoda |
| `server-app/` | Dosya sunucusu (Node + Express) | ⏳ Yakında |
| `desktop-app/` | Masaüstü uygulaması (Windows, Electron) | ⏳ Yakında |

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

1. Bilgisayarda sunucuyu çalıştır (`server-app` yayımlandığında)
2. Sunucuda bir cihaz eşleştirmesi oluştur — sana `deviceId` ve `token` içeren
   bir JSON verir
3. Telefonda **Cihazı Eşleştir** ekranına o JSON'u yapıştır
4. **Sunucu Adresi** ekranına sunucunun adresini gir (örn. `100.64.0.1:4000`)

### Neden düz HTTP?

Uygulama sunucuya `http://` ile bağlanıyor. Şifrelemeyi taşıyan katman
Tailscale'in WireGuard tüneli; trafik zaten cihazların arasından çıkmıyor.
Android 9'dan beri TLS'siz trafik varsayılan olarak engellendiği için
`plugins/withCleartextTraffic.js` bu izni açıyor.

## Lisans

Kişisel bir proje; dilediğin gibi kullanabilirsin.
