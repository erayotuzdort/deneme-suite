# deneme-server

Tailscale ağı üzerinden erişilen, kişisel bir dosya deposu sunucusu. Bir klasör
ağacını (`STORAGE_ROOT`) HTTP üzerinden listeler, indirir ve üzerine dosya/not
yükler; ayrıca eşleştirilmiş cihazları ve en son ne zaman görüldüklerini raporlar.

Her istek **token ile doğrulanır** (`X-Device-Id` + `Authorization: Bearer …`).
Token'ların yalnızca SHA-256 özeti diske yazılır ve karşılaştırma sabit zamanlı
(`timingSafeEqual`) yapılır. Taşıma güvenliği ayrıca Tailscale'in kapalı ağına
dayanır — sunucu düz HTTP konuşur.

## Gereksinimler

- Node.js 20 veya üzeri (geliştirme Node.js 24 ile yapılmıştır)
- npm
- [Tailscale](https://tailscale.com/) — cihazların birbirine ulaşabilmesi için.
  Sunucu `tailscale` komutunu çağırmaz; cihaz listesi kendi `devices.json`
  dosyasından okunur.

## Kurulum

```bash
git clone https://github.com/erayotuzdort/deneme-suite.git
cd deneme-suite/server-app
npm install
copy .env.example .env
```

`.env` dosyasını açıp **mutlaka** `STORAGE_ROOT` değerini kendi makinenizde
dosyaların tutulmasını istediğiniz klasöre göre ayarlayın (aşağıdaki tabloya
bakın) — bu değişken zorunludur, tanımlı değilse sunucu açılışta net bir hata
mesajıyla durur. Klasör önceden var olmalıdır; sunucu onu otomatik oluşturmaz.

```bash
npm run dev
```

Sunucu `http://<HOST>:<PORT>/ping` adresinden ayakta olduğunu doğrulayabileceğiniz
şekilde açılır.

### PowerShell çalıştırma ilkesi (execution policy) notu

Windows'ta `npm` komutları arka planda bir `.ps1` betiği çalıştırdığı için,
varsayılan PowerShell execution policy kısıtlıysa `npm run dev` gibi komutlar
"çalıştırılamıyor çünkü bu sistemde betik çalıştırma devre dışı" hatası
verebilir. Böyle bir durumda, yönetici olmayan bir PowerShell penceresinde:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

çalıştırılabilir.

## .env değişkenleri

| Değişken | Ne işe yarar | Varsayılan |
|---|---|---|
| `HOST` | Sunucunun dinleyeceği ağ arayüzü. Sadece Tailscale üzerinden erişim için `0.0.0.0` bırakılabilir. | `0.0.0.0` |
| `PORT` | Sunucunun dinleyeceği port. | `4000` |
| `STORAGE_ROOT` | Dosyaların okunup yazılacağı kök klasörün mutlak yolu. Klasör önceden var olmalı ve yazma izni bulunmalı. | **Yok — zorunlu.** Tanımlı değilse sunucu "STORAGE_ROOT tanımlı değil" mesajıyla açılışta durur. |

`.env` dosyası `.gitignore` içindedir ve asla commit edilmemelidir.

## npm scriptleri

| Script | Ne yapar |
|---|---|
| `npm run dev` | `tsx watch` ile geliştirme modunda çalıştırır, dosya değişikliklerinde otomatik yeniden başlar. |
| `npm run build` | TypeScript'i `dist/` klasörüne derler. |
| `npm start` | `dist/index.js`'i çalıştırır (önce `npm run build` gerekir). |
| `npm test` | `test/` altındaki otomatik testleri çalıştırır (`node:test`). Her test dosyası kendi geçici deposunu ve rastgele bir portu kullanır; gerçek `STORAGE_ROOT`'a dokunmaz. |

## API referansı

Tüm uç noktalar JSON döner. Başarılı yanıtlarda `ok: true`, hatalarda
`ok: false, error: "<mesaj>"` biçimi kullanılır (dosya indirme akışının
gövdesi zaten gönderilmeye başladıktan sonra oluşan hatalar hariç — bu
durumda bağlantı JSON gövdesi olmadan kapatılır, bu HTTP akışının doğası
gereğidir).

### `GET /ping`

Sağlık kontrolü.

**Yanıt (200):**
```json
{ "ok": true, "server": "<makine-adı>", "timestamp": "2026-09-01T23:00:00.000Z" }
```

### `GET /api/devices`

**Eşleştirilmiş** cihazları (`devices.json`) ve en son ne zaman bu sunucuya
istek attıklarını (`X-Device-Id` header'ı üzerinden) listeler. Son iki dakika
içinde istek atan cihaz `connected: true` sayılır.

**Yanıt (200):**
```json
{
  "ok": true,
  "devices": [
    {
      "deviceId": "0f8f...",
      "name": "mutfak telefonu",
      "pairedAt": "2026-09-01T20:00:00.000Z",
      "lastSeenAt": "2026-09-01T23:00:00.000Z",
      "connected": true
    }
  ]
}
```

> `lastSeen` bellekte tutulur: sunucu yeniden başlatıldığında tüm cihazlar bir
> sonraki isteklerine kadar `connected: false` görünür.

### `GET /api/files?path=<yol>`

Bir klasörün içeriğini listeler. `path` boş bırakılırsa depo kökü listelenir.
`.` ile başlayan dosyalar ve `.meta.json` uzantılı meta dosyaları listede
gösterilmez.

**Yanıt (200):**
```json
{
  "path": "/altklasor",
  "entries": [
    { "name": "resim.jpg", "path": "/altklasor/resim.jpg", "kind": "file", "size": 12345, "modifiedAt": "...", "fileType": "image" }
  ]
}
```

**Hatalar:** `400` yol depo kökü dışına çıkıyor / verilen yol bir klasör
değil · `404` klasör bulunamadı · `503` depo klasörüne erişilemiyor.

### `GET /api/files/download?path=<yol>`

Bir dosyayı indirir. `Range` başlığını destekler (tek aralık; çoklu aralık
istekleri `416` döner).

**Hatalar:** `400` path parametresi eksik / yol depo dışına çıkıyor / verilen
yol bir dosya değil / Range başlığı geçersiz · `404` dosya bulunamadı · `416`
aralık dosya boyutunu aşıyor veya çoklu aralık istendi · `503` depo klasörüne
erişilemiyor · `500` dosya okunurken hata oluştu (ör. dosya başka bir süreç
tarafından kilitli).

### `POST /api/files/upload`

`multipart/form-data` ile dosya ve/veya not yükler.

**Form alanları:**

| Alan | Zorunlu mu | Açıklama |
|---|---|---|
| `files` | Hayır (not gönderiliyorsa) | Birden fazla dosya eklenebilir (aynı alan adıyla tekrarlanır). |
| `note` | Hayır (dosya gönderiliyorsa) | Metin notu. En az bir dosya ya da not gerekir. Sunucu tarafında ~1 MB üstü not reddedilir. |
| `targetPath` | Hayır | Yüklemenin yapılacağı klasör (boşsa depo kökü). |

**Header:** `X-Device-Id` (opsiyonel) — meta dosyasına `uploadedBy` olarak
yazılır ve `/api/devices`'taki `lastSeenAt` değerini günceller.

Aynı ada sahip bir dosya zaten varsa otomatik olarak `ad (1).ext`,
`ad (2).ext` şeklinde numaralandırılır. Her yüklenen dosyanın yanına, notu ve
yükleyen cihazı içeren bir `<dosya>.meta.json` dosyası yazılır.

**Yanıt (200):**
```json
{
  "ok": true,
  "uploaded": [{ "name": "resim.jpg", "path": "/resim.jpg", "size": 12345 }],
  "skipped": [{ "name": "kötü/ad.jpg", "reason": "Geçersiz dosya adı" }]
}
```

**Hatalar:** `400` ne dosya ne not gönderildi / hedef bir klasör değil / hedef
depo dışına çıkıyor / dosya adı geçersiz ya da çok uzun / yükleme isteği
okunamadı (ör. not 1 MB sınırını aştı) · `404` hedef klasör bulunamadı · `503`
depo klasörüne erişilemiyor ya da yazılamıyor.

## Bilinen sınırlamalar

- **Cihazlar arasında yetki ayrımı yok.** Eşleştirilmiş HER cihaz tüm dosyaları
  görebilir, indirebilir, yükleyebilir ve başka bir cihazı (kendisi dahil)
  sistemden çıkarabilir. Sahiplik kontrolü bilinçli olarak yok — tek kullanıcılı
  bir kurulum varsayılıyor.
- **HTTPS yok.** Sunucu düz HTTP üzerinden çalışır; şifreleme Tailscale'in
  kendi WireGuard tünelinden gelir.
- **Token'ın süresi dolmaz.** İptal etmenin tek yolu cihazı çıkarmaktır.
- **Yükleme boyutu sınırsız.** `/api/files/upload` ucunda boyut sınırı yok;
  eşleştirilmiş bir cihaz depo diskini doldurabilir. (Parçalı yükleme ucunda
  parça başına 3 MB sınırı var.)
- **Hız sınırı (rate limit) yok.**
- **Silme uç noktası yok.** Dosyalar yalnızca dosya sistemi üzerinden manuel
  silinebilir.
- **Bildirim sistemi yok.** Yeni bir yükleme olduğunda diğer cihazlara anlık
  bildirim gönderilmez.
- Sunucu beklenmedik şekilde kapanırsa (çökme, güç kesintisi vb.) o an
  sürmekte olan yüklemelerin geçici dosyaları `<STORAGE_ROOT>/.tmp-uploads/`
  içinde kalabilir. Bunlar bir sonraki **açılışta otomatik temizlenir**
  (konsola kaç dosyanın silindiği yazılır); sunucu kapanmadan önce elle
  temizlemek istenirse klasör manuel silinebilir.

## Araştırma belgeleri

Henüz uygulanmamış, sadece araştırılmış konular için ayrı belgeler:

- [`ARASTIRMA-B7b.md`](ARASTIRMA-B7b.md) — devam ettirilebilir (resumable) yükleme
- [`ARASTIRMA-B8.md`](ARASTIRMA-B8.md) — token tabanlı kimlik doğrulama
- [`ARASTIRMA-D1.md`](ARASTIRMA-D1.md) — masaüstü sürümü için teknoloji seçimi
- [`C1-HAZIRLIK.md`](C1-HAZIRLIK.md) — mobil uygulamanın API uyum denetimi
