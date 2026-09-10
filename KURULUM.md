# Kurulum rehberi

Bilgisayarında ve telefonunda hiçbir şey kurulu olmadığını varsayıyoruz. Bu
rehberi baştan sona takip edersen sonunda telefonunla bilgisayarın arasında
dosya gönderip alabiliyor olacaksın.

**Süre:** yaklaşık 15–20 dakika (çoğu indirme beklemesi). Geliştirici aracı
kurmana gerek yok. `*1`

---

## Neye ihtiyacın var

| | |
|---|---|
| Bilgisayar | Windows 10 veya 11 (64-bit) |
| Telefon | Android 7.0 veya üstü |
| Hesap | Ücretsiz bir Tailscale hesabı |
| İnternet | Kurulum için gerekli; sonrasında iki cihaz aynı Tailscale ağında olduğu sürece her yerden çalışır `*2` |

---

## 1. Tailscale hesabı aç

1. [tailscale.com](https://tailscale.com/) → **Get started**
2. Google, GitHub veya Microsoft hesabınla gir

⚠️ Sonraki iki adımda hem bilgisayara hem telefona **aynı hesapla** gireceksin.
Farklı hesaplar kullanırsan cihazlar birbirini göremez — en sık yapılan hata bu.

---

## 2. Bilgisayara Tailscale kur

1. [tailscale.com/download/windows](https://tailscale.com/download/windows) →
   indir ve kur
2. 1. adımdaki hesapla giriş yap
3. Sistem tepsisindeki Tailscale simgesine tıkla — `100.` ile başlayan adresini
   görürsün `*3`

---

## 3. Telefona Tailscale kur

1. Play Store'dan **Tailscale**'i kur
2. 1. adımdaki **aynı hesapla** giriş yap
3. Android VPN izni isteyecek → **İzin ver** `*4`
4. Bağlantıyı **açık** bırak

Artık telefonun Tailscale uygulamasında bilgisayarının adını görüyor olmalısın.

---

## 4. Bilgisayara uygulamayı kur

1. [Releases sayfasından](../../releases/latest) **`deneme-Setup-1.0.0.exe`**
   dosyasını indir (~110 MB)
2. Çalıştır
3. Mavi **"Windows bilgisayarınızı korudu"** ekranı çıkacak: `*5`
   **Daha fazla bilgi** → **Yine de çalıştır**
4. Sihirbazda **İleri → Kur**

Uygulamayı ilk açtığında **Windows Güvenlik Duvarı** izin soracak:
**Özel ağlar** kutusunu işaretle → **Erişime izin ver**. `*6`

---

## 5. Sunucuyu başlat

Sol taraftaki **Sunucu** sekmesine geç.

1. **DEPO KLASÖRÜ** → **Klasör Seç** → telefondan gelen dosyaların duracağı
   klasörü seç `*7`
2. **Başlat**'a bas
3. Kartta **"Çalışıyor: 0.0.0.0:4000"** yazmalı

Pencereyi kapatmak sunucuyu durdurmaz. `*8`

---

## 6. Telefona uygulamayı kur

1. Telefonun tarayıcısından [Releases sayfasına](../../releases/latest) git
2. **`deneme-1.0.0.apk`** dosyasını indir (~100 MB)
3. Dosyaya dokun
4. Android izin isteyecek → **Bu kaynaktan yüklemeye izin ver** → geri dön ve
   kurulumu tamamla
5. Uygulama ilk açıldığında **bildirim izni** isteyecek → izin ver `*9`

---

## 7. Telefonu bilgisayara bağla

Telefona iki şey gireceksin: bir **adres** ve bir **eşleştirme kodu**. İkisini de
bilgisayar veriyor.

### Bilgisayarda

1. **Sunucu** sekmesi → **EŞLEŞTİRİLMİŞ CİHAZLAR** başlığının sağındaki **+**
2. Açılan kartta **`Tailscale`** etiketli satırdaki adresi kopyala
   (örn. `http://100.64.0.1:4000`)
3. Cihaz adı yaz (örn. `telefonum`) → **Oluştur**
4. Çıkan `{"deviceId":"…","token":"…"}` kodunu **Kopyala** `*10`

### Telefonda

1. Uygulamayı aç → alttaki **Aktarım** sekmesi
2. Sağ üstteki **dişli** simgesi (*Sunucu ayarları*) → **SUNUCU ADRESİ** alanına
   bilgisayardaki adresi gir → kaydet `*11`
3. Sağ üstteki **+** simgesi (*Cihaz ekle*) → **EŞLEŞTİRME KODU** alanına kodu
   yapıştır → kaydet `*12`

---

## 8. Çalıştığını doğrula

Telefonda **Aktarım** sekmesindeki **SUNUCU** kartına bak:

- **Bağlı** → tamam
- **Bağlanamıyor** → karta dokun (yeniden kontrol eder). Düzelmezse aşağıya bak.

Sonra gerçek bir aktarım dene:

1. Telefonda **Aktarım** → **Dosya seç** → bir fotoğraf → **Yükle**
2. Bilgisayarda **Bildirimler** sekmesinde görünmeli
3. Bildirime tıkla → dosya açılır

---

## Sorun giderme

**Telefonda "Bağlanamıyor" yazıyor** — sırayla kontrol et:

1. Tailscale iki cihazda da açık mı?
2. İkisi de aynı Tailscale hesabında mı? (Telefondaki Tailscale'de bilgisayarının
   adını görüyor musun?)
3. Bilgisayarda sunucu "Çalışıyor" durumunda mı?
4. Adres doğru mu? Bilgisayardaki **`Tailscale`** satırıyla birebir aynı olmalı.
   Yerel ağ adresi (`192.168.…`) yalnızca ikisi aynı Wi-Fi'dayken çalışır.
5. Güvenlik duvarı izni verildi mi? → Windows Güvenlik Duvarı → "Uygulamanın
   güvenlik duvarı üzerinden iletişim kurmasına izin ver" → **deneme** → Özel
   ağlar işaretli olmalı

**"Kimlik doğrulama başarısız"** — eşleştirme kodu geçersiz olmuş (örn. o cihazı
bilgisayardan çıkardıysan). Bilgisayarda yeni kod üret, telefonda **Cihaz ekle**
ekranından tekrar yapıştır.

**"Port 4000 zaten kullanımda"** — başka bir program o portu tutuyor. Sunucu
durmuşken **PORT** alanını `4001` yap, tekrar başlat. Telefondaki adresi de yeni
portla güncelle.

**Açılışta kendiliğinden başlamasın** — Sunucu sekmesinde **"Windows açılışında
otomatik başlat"** kutusunun işaretini kaldır.

---

## Notlar

`*1` — Node.js, npm, Android Studio, Expo: hiçbiri gerekmiyor. Hazır dosyaları
indirip kuruyorsun. Kaynaktan derlemek istersen [en aşağıya](#ek-kaynaktan-derlemek) bak.

`*2` — Bu uygulama bulut kullanmıyor; dosyalar telefonunla bilgisayarın arasında
doğrudan gidiyor. Tailscale, iki cihazını sanki aynı ev ağındaymış gibi birbirine
bağlayan özel bir tünel kuruyor. Onsuz telefon bilgisayarı bulamaz.

`*3` — Bu adresi ezberlemene gerek yok; uygulama 7. adımda sana zaten gösterecek.

`*4` — Tailscale teknik olarak bir VPN olarak çalışıyor, bu yüzden Android izin
istiyor. Trafiğin bir şirkete gitmiyor; sadece kendi cihazlarının arasında dolaşıyor.

`*5` — Bu uyarı dosyanın zararlı olduğu anlamına gelmiyor. Kurulum dosyası
**imzasız** olduğu için çıkıyor — kod imzalama sertifikası ücretli olduğundan
şimdilik imzalanmıyor. Kaynak kodun tamamı bu depoda, dilersen kendin derleyebilirsin.

`*6` — Bu izni vermezsen telefon bilgisayara bağlanamaz. Yanlışlıkla "İptal"
dediysen sorun değil, sorun giderme bölümündeki 5. maddeden elle ekleyebilirsin.

`*7` — Örneğin `Belgeler\deneme` gibi yeni bir klasör oluşturabilirsin. Telefon
bu klasörün içindekileri görebilecek ve içine yazabilecek, o yüzden özel
dosyalarının olduğu bir klasörü (ör. tüm `Belgeler`) seçme.

`*8` — Uygulama sistem tepsisinde çalışmaya devam eder; telefon böylece pencere
kapalıyken de dosya gönderebilir. Tamamen kapatmak için tepsi simgesine sağ
tıklayıp **Çıkış** de.

`*9` — Bildirim izni, dosya aktarımının ilerlemesini bildirim çubuğunda göstermek
için kullanılıyor. Vermezsen aktarım yine çalışır ama arka plandayken ilerlemeyi
göremezsin.

`*10` — Kodu telefona geçirmenin en pratik yolları: kendine WhatsApp mesajı
atmak, e-posta göndermek ya da senkronize bir not uygulamasına yapıştırmak.
Kod tek kullanımlık değil ama kimseyle paylaşma — o kodla sahip olan kişi depo
klasörüne erişebilir.

`*11` — `http://` yazmasan da olur, otomatik ekleniyor. Adres kaydedilirken
bağlantı **denenmez**; doğru çalışıp çalışmadığını 8. adımda göreceksin.

`*12` — Kodun tamamını yapıştırdığından emin ol — baştaki `{` ve sondaki `}`
dahil. Eksik yapıştırırsan "Geçerli bir JSON değil" uyarısı alırsın.

---

## Ek: kaynaktan derlemek

**Gerekenler:** Node.js 20+, npm. Telefon için ayrıca bir
[Expo](https://expo.dev/) hesabı.

```bash
git clone https://github.com/erayotuzdort/deneme-suite.git
cd deneme-suite

cd mobile-app  && npm install && cd ..                    # masaüstünün tipleri buna bağlı
cd server-app  && npm install && npm run build && cd ..   # dist/ üretmeli
cd desktop-app && npm install && npm run package          # release/ altında kurulum dosyası
```

Sıra önemli: `server-app` derlenmemişse `desktop-app`'in kurulumu hata verir.

Telefon uygulaması için:

```bash
cd mobile-app
npx eas login      # kendi Expo hesabın
npx eas init       # bu kopyayı kendi Expo projene bağlar
npx eas build --profile preview --platform android
```

`eas init` adımı gerekli: depoda hiçbir Expo proje kimliği tutulmuyor, herkes
kendi hesabına bağlar.
