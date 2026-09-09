# Araştırma: B8 — Token Tabanlı Kimlik Doğrulama

Bu belge yalnızca araştırma içindir, kod içermez. Bağlam: arkadaşlar/aile
kullanacak, teknik bilgileri yok, her biri kendi sunucusunu kendi
bilgisayarında çalıştıracak — bu yüzden kurulum akışı basit ve hataya
dayanıklı olmalı.

## a) Token nasıl üretilir?

- **Seçenek 1 — ham rastgele bayt, hex:** `crypto.randomBytes(32).toString('hex')`
  → 64 karakter, 256 bit entropi. Node'un yerleşik `crypto` modülü,
  ekstra bağımlılık yok.
- **Seçenek 2 — UUID v4:** `crypto.randomUUID()` → 36 karakter (tireli),
  128 bit entropi. Daha kısa, yerleşik, ama biraz daha az entropi (yine de
  brute-force'a karşı fazlasıyla yeterli).
- (Üçüncü, orta seçenek: `crypto.randomBytes(24).toString('base64url')` →
  32 karakter, 192 bit — hex'ten kısa, UUID'den daha yüksek entropili.)

İkisi de kriptografik olarak güvenli rastgelelik kaynağı kullanır
(`crypto.randomBytes`/`randomUUID` işletim sisteminin CSPRNG'ine dayanır).

## b) Token sunucuda nerede saklanır? (Veritabanı yok)

- **Seçenek 1 — dosya tabanlı token listesi:** Proje dizininde (depo
  klasörünün İÇİNDE DEĞİL — `STORAGE_ROOT` kullanıcıya açık dosya alanı)
  ör. `tokens.json`:
  ```json
  [{ "tokenHash": "sha256:...", "deviceId": "...", "label": "Ayşe'nin telefonu", "createdAt": "..." }]
  ```
  Token'ın kendisi değil, **hash'i** saklanır (parola saklama pratiğiyle
  aynı mantık) — dosya yanlışlıkla paylaşılsa/yedeklense bile çalınan
  şey doğrudan kullanılamaz.
- **Seçenek 2 — tek paylaşılan token, `.env` içinde:** `AUTH_TOKEN=...`.
  En basiti; cihaz bazlı ayrım yapılamaz (bkz. madde f).

`.env` zaten `.gitignore`'da; `tokens.json` da aynı şekilde
`.gitignore`'a eklenmeli.

## c) Token istemciye nasıl ulaşır?

### 1. Elle kopyala-yapıştır
1. Sunucu çalıştırılır; terminal (veya bir `.txt` çıktı dosyası) token'ı
   gösterir.
2. Kullanıcı telefonda uygulamayı açar, Ayarlar'a girer.
3. Token alanına terminaldeki uzun karakter dizisini elle yazar ya da
   kopyalar.
4. "Kaydet"e dokunur.
- **Değerlendirme:** En az geliştirme gerektirir ama teknik bilgisi
  olmayan biri için 64 karaktelik bir hex dizisini hatasız girmek zor;
  hata ayıklaması da zor ("neden bağlanmıyor" — muhtemelen bir karakter
  yanlış girildi).

### 2. QR kod
1. Sunucu çalıştırılır; aynı ağdaki bir tarayıcıdan
   `http://<sunucu-adresi>:<port>/pair` açılır, bu sayfa token'ı (ve
   sunucu adresini) kodlayan bir QR gösterir.
2. Kullanıcı telefonda uygulamayı açar, "QR ile bağlan"a dokunur.
3. Kamerayı ekrandaki koda doğrultur.
4. Uygulama adres + token'ı otomatik okur, kaydeder, bağlantıyı doğrular.
- **Değerlendirme:** Kullanıcı hiçbir şey elle yazmaz, hata payı en düşük.
  Mobilde `expo-camera`/barkod tarama gerektirir (zaten proje bağımlılığı
  değil, eklenmesi gerekir). Sunucu tarafında basit bir HTML+QR üretici
  sayfa gerekir.

### 3. Eşleştirme kodu (kısa, insan-dostu kod)
1. Sunucu çalıştırılır; 6 haneli kısa bir kod (ör. "482913") ve sunucunun
   Tailscale adresi ekranda gösterilir. Bu kod **token'ın kendisi
   değildir**, kısa ömürlü bir eşleştirme anahtarıdır.
2. Kullanıcı uygulamada "Cihaz Ekle"ye dokunur, sunucu adresini girer.
3. Ekrandaki 6 haneli kodu uygulamaya girer.
4. Uygulama, kodu sunucuya gönderip karşılığında gerçek (uzun) token'ı
   alır ve güvenli depoya kaydeder; kısa kod bir kereliğine geçerlidir ve
   kullanıldıktan/süresi dolduktan sonra geçersiz olur.
- **Değerlendirme:** Kullanıcı deneyimi açısından en dostu (kısa sayı
  dizisi yazmak, uzun hex dizisinden çok daha az hataya açık), ama sunucu
  tarafında en fazla yeni mantık gerektiren seçenek: geçici kod üretme,
  süre aşımı, kod↔token değişim uç noktası.

**Öneri (uygulanmadı, sadece not):** Başlangıç için (2) QR kod, en iyi
emek/fayda dengesini sunar — (3)'ten daha az sunucu-tarafı karmaşıklığı,
(1)'den çok daha az kullanıcı hatası riski.

## d) Token istemcide nasıl saklanır?

- **AsyncStorage:** Şifrelenmemiş anahtar-değer deposu (Android'de SQLite
  tabanlı, iOS'ta benzer bir yerel depoya yazar). Cihaza fiziksel/root
  erişimi olan biri ya da bir yedek dosyası inceleyen biri okuyabilir.
  Tema tercihi gibi hassas olmayan ayarlar için uygundur.
- **expo-secure-store:** İşletim sisteminin güvenli deposunu kullanır
  (iOS Keychain, Android Keystore/EncryptedSharedPreferences) — disk
  üzerinde şifrelidir, cihaza özeldir. Depolama boyutu sınırlıdır (bazı
  platformlarda öğe başına ~2 KB) ama bir token için fazlasıyla yeterli.

**Sonuç:** Token mutlaka `expo-secure-store`'da saklanmalı; AsyncStorage
sadece hassas olmayan ayarlar için kalmalı.

## e) Token iptal edilebilmeli mi, nasıl?

Evet, edilebilmeli — bir telefon kaybolur/satılırsa erişimini kesebilmek
için. Veritabanı olmadığından:

- Token listesi (`tokens.json`) dosyasından ilgili satırı silmek yeterli;
  bu, sunucunun ölçeğine göre elle (dosyayı düzenleyip sunucuyu yeniden
  başlatarak) ya da küçük bir yerel CLI script'iyle (`npm run
  revoke-token -- <cihaz-etiketi>`) yapılabilir. Aile ölçeğinde bir araç
  için tam bir "admin paneli" fazla mühendislik olur.
- Tek-paylaşılan-token modelinde (madde f) iptal = token'ı yeniden
  üretip herkese yeniden dağıtmak — kaba ama basit.

## f) Cihaz başına ayrı token mı, tek token mı?

| | Tek paylaşılan token | Cihaz başına token |
|---|---|---|
| Kurulum | En basit — bir kere üret, herkese ver | Her cihaz için eşleştirme akışı gerekir |
| İptal | Herkesi aynı anda keser | Sadece o cihazı keser |
| Kayıt/denetim | "Kim ne yaptı" ayrımı yok | Loglarda hangi cihazın istek attığı bilinir |

Proje zaten bir `X-Device-Id` kavramına sahip (cihazların son görülme
zamanını takip etmek için) — **cihaz başına token**, bu mevcut kavramın
doğal bir uzantısı olur ve daha güvenli/esnek bir model sunar. Ama bu bir
ürün kararıdır, burada uygulanmadı.

## g) HTTP'de nasıl taşınır?

**Önerilen: `Authorization: Bearer <token>` başlığı.**

- RFC 6750'nin standart yöntemi; tüm HTTP istemcileri/fetch tarafından
  doğal desteklenir.
- Query param'ın (`?token=...`) aksine sunucu erişim loglarına, tarayıcı
  geçmişine ya da bir bağlantı olarak paylaşılan URL'lere sızmaz.
  **Somut risk:** `/api/files/download?path=...` uç noktası zaten
  query param kullanıyor; token da query param'a konsaydı, biri bir
  "indirme bağlantısını" aile grubunda paylaştığında token da bilmeden
  ifşa olurdu.
- Özel bir header (ör. `X-Auth-Token`) işlevsel olarak benzer olur ama
  standart `Authorization` başlığından üstün bir yanı yok; sadece başka
  bir yetkilendirme şemasıyla birlikte yaşaması gerekiyorsa anlamlı
  olurdu (burada geçerli değil).

## h) Tailscale zaten ağ katmanında koruyorken token ne ekliyor?

Tailscale, sunucunun IP:port'una yalnızca aynı tailnet'teki cihazların
ulaşabilmesini sağlar — bu, internetteki rastgele saldırganları ve
tailnet dışındaki herkesi durdurur. Ama Tailscale, tailnet **içindeki**
bir cihazın sunucudaki HANGİ isteği attığını ayırt etmez ya da o cihazın
"yetkili uygulama" olup olmadığını bilmez.

**Somut senaryo:** Bir aile üyesinin eski telefonu, cihaz kendisine
verilmeden/satılmadan önce Tailscale ağından çıkarılmayı unutulmuş olsun.
Ya da: aynı tailnet'teki paylaşılan bir ev sunucusu/NAS'ta çalışan başka
bir servis (ya da o makineye erişimi olan biri) `curl` ile doğrudan
`/api/files` uç noktasına istek atabilir — Tailscale bunu engellemez,
çünkü o cihaz zaten ağın "içinde". Token olmadan, tailnet'te olan HERKES
tüm dosyaları listeleyip indirebilir/yükleyebilir. Token varsa, sadece
uygulamanın kendisinin (token'ı `expo-secure-store`'da tutan) bildiği bir
sırrı sunan istekler kabul edilir — tailnet üyeliği tek başına yetmez.
Ayrıca token, tek bir cihazın erişimini **tüm tailnet'i değiştirmeden**
iptal etmeyi mümkün kılar (madde e).

Kısacası: Tailscale "kim bu ağa girebilir", token ise "bu ağdaki kim bu
API'yi kullanabilir" sorusunu cevaplar — ikisi farklı katmanlarda çalışan,
birbirini tamamlayan kontrollerdir.

## i) Hangi uç noktalar token istemeli? `/ping` istemeli mi?

**Öneri: `/ping` açık (token'sız) kalmalı; `/api/files*` ve
`/api/devices` token istemeli.**

- `/ping` lehine (açık kalması): Mobil uygulama, eşleştirme akışından
  ÖNCE bile "bu adreste gerçekten bir deneme-server var mı" diye kontrol
  edebilmeli (bkz. `aktarim.tsx`'teki `checkServer()`). `/ping` token
  isterse, "yanlış adres" ile "doğru adres ama token'ım yok/yanlış"
  hataları ayırt edilemez hale gelir — ilk kurulumda hata ayıklamayı
  zorlaştırır. `/ping`'in ifşa ettiği veri (sunucu adı, saat) önemsizdir.
- `/ping` aleyhine (token istemesi gerektiği): Tutarlılık — her uç nokta
  aynı kuralı takip eder, kodda özel durum yönetimi gerekmez; ayrıca
  sunucu adı (`config.serverName`, yani makinenin hostname'i) tailnet'teki
  yetkisiz biri için ufak da olsa bir bilgi sızıntısıdır.
- `/api/devices` özellikle korunmalı çünkü Tailscale IP'leri ve
  cihazların çevrimiçi durumu gibi ağ topolojisi bilgisi taşıyor — bu,
  `/ping`'in ifşa ettiğinden daha hassas.

Bu bir öneridir, nihai karar (ve token doğrulama mantığının nereye
ekleneceği) kullanıcıya aittir; burada kod yazılmadı.
