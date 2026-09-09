# Araştırma: B7b — Devam Ettirilebilir (Resumable) Yükleme

Bu belge yalnızca araştırma içindir, kod içermez. Amaç: bağlantı kesintisinde
kaldığı yerden devam edebilen dosya yüklemesi için en uygun yaklaşımı seçmek.

## a) Üç yaklaşımın karşılaştırması

### 1. tus protokolü (tus.io)

Açık, HTTP tabanlı, yaygın kabul görmüş bir devam ettirilebilir yükleme
standardı. `PATCH` istekleri + `Upload-Offset`/`Upload-Length` başlıklarıyla
çalışır.

- **Artı:** Olgun, iyi test edilmiş, istemci/sunucu kütüphaneleri hazır;
  ileride başka istemciler (web, masaüstü) eklenirse hepsi aynı protokolü
  konuşur.
- **Eksi:** Projeye tamamen yeni bir bağımlılık ailesi getirir
  (`@tus/server`, `@tus/file-store`). `PATCH` + ham gövde akışı, mevcut
  multer/busboy tabanlı multipart akışından farklı bir istek işleme modeli
  gerektirir — dosya yükleme rotası kavramsal olarak ikiye bölünür (normal
  yükleme: multer; resumable yükleme: tus). React Native/Expo tarafında
  resmi bir "expo-uyumlu" tus istemcisi yok; `tus-js-client` teorik olarak
  çalışır ama Expo'nun dosya sistemi soyutlamasıyla (büyük dosyayı bellekte
  tutmadan parça parça okuma) entegrasyonu ekstra iş gerektirir.

### 2. Content-Range ile parçalı PUT (Google/YouTube tarzı resumable upload)

İstemci bir "yükleme oturumu" açar, sonra dosyayı parçalar hâlinde ardışık
`PUT` istekleriyle gönderir; her istek `Content-Range: bytes X-Y/total`
başlığı taşır, sunucu alınan toplam bayt sayısını doğrulayıp bir sonraki
beklenen offset'i döner.

- **Artı:** Standart bir HTTP deseni, tus kadar olmasa da tanıdık (birçok
  bulut depolama API'si bunu kullanır). Sunucu tarafı mantığı tus'a göre
  daha az kod ister (kendi minik protokolümüz).
- **Eksi:** Yine `PUT` + ham gövde gerektirir, multer'ın multipart
  varsayımıyla uyuşmaz; bu rotalar için multer'ı devre dışı bırakıp ham
  `req` stream'ini elle işlemek gerekir. Offset doğrulama, çakışan/parça
  kaybı senaryoları (aynı offset'e iki kez yazma vb.) elle ele alınmalı.

### 3. Kendi chunk protokolümüz (parçaları ayrı multipart POST'larla gönderme)

İstemci dosyayı sabit boyutlu parçalara (ör. 1-4 MB) böler, her parçayı
`{uploadId, chunkIndex, totalChunks}` alanlarıyla birlikte **normal bir
multipart POST** olarak gönderir (tıpkı bugünkü `/api/files/upload` gibi).
Sunucu her parçayı `.tmp-uploads/<uploadId>/<chunkIndex>.part` olarak
yazar; tüm parçalar tamamlanınca (ya istemcinin ayrı bir "/complete"
çağrısıyla ya da sunucunun periyodik kontrolüyle) parçalar sırayla
birleştirilip nihai dosya oluşturulur.

- **Artı:** **Mevcut multer/busboy akışını hiç değiştirmeden aynen
  kullanır** — her parça zaten desteklenen bir multipart POST'tur. Yeni
  bağımlılık gerekmez. Durum tamamen dosya sisteminde (parça dosyalarının
  varlığı = durumun kendisi) tutulur, bu da projenin "veritabanı yok, her
  şey dosya sisteminde" felsefesiyle birebir örtüşür.
- **Eksi:** Sıra dışı/eksik parça, kısmi/bozuk parça, eşzamanlı parça
  yüklemesi gibi durumlar elle çözülmeli — tus/Content-Range'in hazır
  çözdüğü şeyleri biz yazarız.

## b) Her yaklaşım için gereksinimler (kaba tahmin)

| Yaklaşım | Sunucu | Mobil | Süre (tahmini) | Paketler |
|---|---|---|---|---|
| tus | `@tus/server` + `@tus/file-store` ile ayrı bir router; auth/deviceId `Upload-Metadata`'ya taşınmalı | `tus-js-client` entegrasyonu + Expo dosya okuma köprüsü | ~1–1.5 hafta | `@tus/server`, `@tus/file-store`, (mobil) `tus-js-client` |
| Content-Range PUT | Oturum başlatma/sorgulama/PUT uç noktaları, ham stream işleme, offset doğrulama | Özel PUT döngüsü + yeniden bağlanma mantığı | ~1 hafta | yok (yerleşik `http`/`fetch` yeterli) |
| Kendi chunk protokolümüz | Parça alma + durum sorgulama + birleştirme uç noktaları (mevcut multer deseniyle) | Dosyayı parçalayıp sırayla POST eden döngü + eksik parça sorgulama | ~3–5 gün | yok |

(Süreler, bu projeyi tek başına geliştiren birinin diğer işlerin yanında
ayırabileceği zamana göre kabaca verilmiştir; kesin değildir.)

## c) Mevcut yığına (multer + Express + TypeScript) en az sürtünmeyle oturan

**Kendi chunk protokolümüz.** Gerekçe: multer zaten her parçayı olduğu
gibi işleyebilir (parça = küçük bir multipart POST), bu yüzden mevcut
`upload.ts`/`routes/files.ts` mimarisine yeni bir "ham stream işleme modu"
eklemeye gerek kalmaz. tus ve Content-Range/PUT yaklaşımlarının ikisi de
multer'ın varsayımıyla (çok parçalı form verisi) çelişen, ham istek
gövdesi okuyan ayrı bir kod yolu gerektirir — bu, mevcut mimariye en çok
sürtünen kısımdır.

## d) Yarım kalan yüklemelerin durumu nerede tutulur?

Veritabanı yok; **dosya sisteminin kendisi durumdur**, tıpkı bugünkü
`.meta.json` sidecar deseninde olduğu gibi:

```
<STORAGE_ROOT>/.tmp-uploads/<uploadId>/
  0000.part
  0001.part
  ...
  .session.json   <- { targetPath, note, deviceId, totalChunks, fileName, createdAt }
```

İstemci yeniden bağlandığında sunucudan "hangi parçalar zaten var"
bilgisini (klasördeki dosya adlarını listeleyerek) alır ve yalnızca eksik
parçaları gönderir. Ayrı bir veritabanı/JSON kayıt dosyası tutmaya gerek
yok — `readdir` zaten doğruyu söyler; `.session.json` sadece parça
sayısıyla ilgisi olmayan bilgiyi (hedef klasör, not, cihaz kimliği) taşımak
için gerekir.

## e) Yarım kalanlar ne zaman temizlenir?

Üç mekanizma birlikte önerilir:

1. **Açılışta (zaten var):** Görev 1'de eklenen `cleanupOrphanedTempUploads`
   zaten `.tmp-uploads` içindeki dosyaları siliyor. B7b eklenirse bu
   fonksiyon, alt klasörleri (uploadId'leri) de gezip **süresi geçmiş**
   olanları silecek şekilde genişletilmeli (bkz. madde 2).
2. **Süre aşımı (TTL):** Her `.session.json`'a bir `createdAt` zaten
   yazılıyor olacağından, belirli bir yaştan (ör. 24–48 saat) eski
   oturumlar açılışta ya da düzenli bir kontrol sırasında silinebilir.
3. **Elle:** İstemcinin "aktarımı iptal et" dediği anda ilgili
   `<uploadId>` klasörünü tamamen silen bir `DELETE` uç noktası.

## f) expo-file-system resumable YÜKLEMEYİ destekliyor mu?

**Hayır — kesin cevap, Expo'nun resmi v54.0.0 dokümantasyonu kontrol
edildi.** `expo-file-system`'de resumable (devam ettirilebilir) özellik
**sadece indirmede** var (`FileSystem.createDownloadResumable`). Yükleme
tarafında:

- Eski (legacy, artık deprecated) API'de `FileSystem.createUploadTask()`
  ve `FileSystem.uploadAsync()` var, ama ikisi de **tek seferlik**;
  resumable/pause/resume parametresi yok.
- Yeni API'de yükleme, `File` sınıfının `Blob` arabirimini uygulaması
  sayesinde `expo/fetch` + `FormData` üzerinden yapılıyor (mevcut
  `services/api.ts`'in muhtemelen zaten yaptığı gibi) — burada da
  herhangi bir devam ettirme özelliği dokümante edilmiş değil.

Sonuç: resumable yükleme, expo-file-system'den "bedava" gelmeyecek;
madde (a)'daki üç yaklaşımdan hangisi seçilirse seçilsin, mobil tarafta
parçalama/ilerleme takibi/yeniden bağlanma mantığı **elle** yazılmalı.
