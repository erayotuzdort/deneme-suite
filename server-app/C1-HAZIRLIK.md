# C1 Hazırlık: Mobil API Uyum Denetimi

`deneme-app/services/api.ts` (ve onu kullanan `device-context.tsx`,
`explore.tsx`, `aktarim.tsx`) okunup gerçek `deneme-server` API'siyle
karşılaştırıldı. Bu belge sadece **denetim** raporudur — Görev 4 dışında
`deneme-app`'e hiçbir değişiklik yapılmadı.

## a) `getFiles()` — `/api/files` yanıt biçimini doğru bekliyor mu?

**Hayır, ciddi bir uyumsuzluk var.**

- **Sunucu gerçekte döner:** `{ path: string, entries: DirectoryEntry[] }`
  — `DirectoryEntry = { name, path, kind: "folder"|"file", size:
  number|null, modifiedAt, fileType }`. Tek seviyelidir; bir klasörün
  içini görmek için `?path=` ile AYRI bir istek atılması gerekir
  (`children` alanı yoktur, iç içe ağaç dönmez).
- **İstemcinin beklediği (`ApiFileEntry` tipi):** `type: 'file'|'folder'`,
  `id`, ve klasörler için doğrudan gömülü `children: ApiFileEntry[]`
  (tam, önceden getirilmiş bir ağaç).
- **`getFiles()`'ın kendisi** `request('/api/files')` çağrısının SONUCUNU
  doğrudan `ApiFileEntry[]` olarak cast'liyor — ama sunucu bir DİZİ değil,
  `{path, entries}` şeklinde bir NESNE dönüyor. `explore.tsx` bu sonucu
  doğrudan `tree` state'ine koyup üzerinde `.map()`/`.filter()`
  (`filterTree`, `flattenTree`) çağırıyor — bir nesne üzerinde bu
  metodlar çalışmaz, **çalışma zamanında patlar**.
- Alan adı farkı: sunucu `kind`, istemci `type` bekliyor.
- Kimlik alanı farkı: sunucu `path` kullanıyor (ör.
  `/altklasor/dosya.txt`), istemci her yerde `id` bekliyor — sunucu
  yanıtında `id` alanı hiç yok.
- Sunucu, listeleme yanıtında `note`/`uploadedBy`/`uploadedAt` DÖNMÜYOR
  (bunlar sadece `.meta.json` sidecar dosyasında duruyor, hiçbir uç nokta
  onu listelemeye dahil etmiyor) — istemcinin tipi bu alanları
  (opsiyonel de olsa) bekliyor; sunucuda bunları listelemeye ekleyecek
  bir yetenek şu an yok.

**Sonuç:** Bu dosya, sunucu henüz yazılmadan önce (kod içindeki yorum da
bunu doğruluyor: "Sunucu çalışmaya başlayınca burada port doğrulanacak")
tahmine dayalı yazılmış; gerçek sunucu API'siyle örtüşmüyor.

## b) `downloadFile()` — `/api/files/download?path=` mi, yoksa eski `/api/files/:id/download` mı?

**Eski biçim kullanılıyor.** `getDownloadUrl()`:
```
${API_BASE_URL}/api/files/${encodeURIComponent(fileId)}/download
```
Sunucunun gerçek uç noktası ise `GET /api/files/download?path=<yol>`
(sorgu parametreli). Bu iki biçim uyuşmuyor; istemci şu an var olmayan
bir rotaya istek atıyor.

## c) `uploadFiles()` — beklenen alan adlarını (`files`, `note`, `targetPath`) kullanıyor mu?

Kısmen:
- `files` — ✅ doğru alan adı, çoklu dosya doğru ekleniyor.
- `note` — ✅ doğru alan adı (boşsa hiç eklenmiyor, sunucu da boş notu
  kabul ediyor, sorun yok).
- `targetPath` — ❌ **hiç gönderilmiyor.** Sunucu bunun eksik olmasını
  hataya çevirmiyor (boş sayıp depo köküne yazıyor), yani istek
  başarısız OLMUYOR ama **istemci şu an asla bir alt klasöre yükleme
  yapamıyor**, her şey her zaman köke gidiyor.

## d) `X-Device-Id` header'ı gönderiliyor mu?

**Hayır, hiçbir istekte gönderilmiyor** (ne `request()` yardımcısında ne
de ayrı XHR tabanlı `uploadFiles()`'ta). Sonuçları:
- `/api/devices`'taki `appConnected`/`lastSeenAt` bu uygulamadan gelen
  istekler için her zaman `false`/`null` kalır (sunucu, cihazın "en son
  ne zaman uygulamadan istek attığını" hiç öğrenemez).
- Yüklenen her dosyanın `.meta.json`'ındaki `uploadedBy` alanı her zaman
  `null` olur.

## e) `API_BASE_URL` hâlâ sabit mi?

**Evet** — `services/api.ts:7`:
```ts
export const API_BASE_URL = 'http://100.64.0.1:4000';
```
Derleme zamanında gömülü, sabit bir Tailscale IP + port. Değiştirmek
için (yalnızca listeleniyor, değiştirilmedi):
- `services/api.ts` — `API_BASE_URL` sabit yerine, çalışma zamanında
  (güvenli depodan) okunan bir değere dönüştürülmeli; `request()`,
  `getDownloadUrl()`, `getUploadUrl()` bu değeri her çağrıda güncel
  okumalı (modül yüklenirken bir kere sabitlenmemeli).
- Yeni bir ayarlar/eşleştirme ekranı (şu anki üç sekmenin hiçbirinde
  sunucu adresi girme alanı yok) — bu, B8 araştırmasındaki (Görev 6)
  token eşleştirme akışıyla doğal olarak aynı yerde ele alınabilir.
- `contexts/device-context.tsx` ve diğer tüketiciler `services/api.ts`
  export'larını olduğu gibi çağırdığı için, değişiklik `api.ts` içinde
  kalırsa onları değiştirmek GEREKMEZ.

## f) C1'de yapılacak işler (madde madde)

1. `ApiFileEntry` tipini sunucunun gerçek `DirectoryEntry` şekline
   (`kind`, `path`, `size: number|null`, `fileType`, çocuksuz/tek
   seviyeli) göre yeniden yaz.
2. `getFiles()`'ı `{path, entries}` zarfını doğru açacak şekilde düzelt.
3. **Mimari değişiklik:** Dosyalar ekranının "tek istekte tüm ağacı çek"
   modelini, sunucunun tek-seviyeli API'sine uygun "klasör açıldıkça
   `?path=` ile o seviyeyi getir" (tembel/lazy) modeline çevir — bu,
   sadece `api.ts`'i değil `explore.tsx`'in veri akışını da etkiler.
4. `getDownloadUrl()`'ı `/api/files/download?path=<yol>` biçimine
   düzelt.
5. `uploadFiles()`'a `targetPath` alanını ekle (alt klasöre yükleme
   desteği için).
6. Her isteğe (hem `request()` hem `uploadFiles()`'taki XHR'a)
   `X-Device-Id` header'ı ekle.
7. `API_BASE_URL`'i çalışma zamanında ayarlanabilir yap + bunu
   girebileceği bir arayüz ekle (madde e).
8. B8 (Görev 6) araştırmasında seçilecek eşleştirme akışını uygula:
   token'ı `expo-secure-store`'da sakla, her isteğe `Authorization:
   Bearer <token>` ekle.
9. **Upload stratejisi (KARAR VERİLDİ):** Dosya boyutuna göre otomatik
   seçim — **20 MB** altı `POST /api/files/upload` (normal, tek
   istek), 20 MB ve üzeri `POST /api/files/upload/chunk` (B7b'de
   yazılan resumable protokol, 2 MB'lık parçalar). Chunk yolunda
   `GET /api/files/upload/status` ile ilerleme takip edilir, ağ
   kopmasında kalınan yerden devam edilir, kullanıcı iptal ederse
   `DELETE /api/files/upload/:uploadId` çağrılır.
10. **401 davranışı (KARAR VERİLDİ):** Herhangi bir istekte 401
    alınırsa — otomatik yeniden eşleştirme. `expo-secure-store`'daki
    token silinir, kullanıcı doğrudan madde 8'deki QR eşleştirme
    ekranına yönlendirilir (mevcut eşleştirme bilgisi elle
    saklanmaz/onaylanmaz, akış eşleştirme yapılmamış cihazla aynıdır).
11. Sunucunun listeleme yanıtı `note`/`uploadedBy` döndürmediğinden,
    Dosyalar ekranının bu bilgiyi göstermesi isteniyorsa **sunucu
    tarafında da** yeni bir yetenek gerekir (bu C1'in mobil kapsamının
    dışında, ayrı bir sunucu görevi olarak not düşülüyor).
12. **Dev build'e geçiş:** Proje şu an yalnızca Expo'nun yönetilen
    (managed) SDK modüllerini kullanıyor, muhtemelen Expo Go ile test
    ediliyor. `expo-camera`/barkod tarama (B8'in QR eşleştirme seçeneği
    için, Görev 6) ve aşağıdaki foreground service gibi ihtiyaçlar
    native modül gerektirebileceğinden, C1 kapsamına girmeden önce
    `expo-dev-client` ile bir **development build**'e geçilmesi
    önerilir — Expo Go, keyfi native modülleri desteklemez.
13. **Foreground service (arka planda indirme/yükleme için kalıcı
    bildirim):** Android, uygulama arka plana alındığında büyük bir
    indirme/yüklemeyi kesintiye uğratabilir; bunu önlemek için gerçek
    bir Android foreground service + kalıcı bildirim gerekir. Bu, Expo
    çekirdek SDK'sının **hazır sunmadığı** bir yetenektir — ya bir
    topluluk native modülü (ör. bildirim kalıcılığı sağlayan bir
    foreground-service kütüphanesi) ya da özel bir native/config-plugin
    entegrasyonu gerektirir. Bu, C1 içinde küçük bir alt madde değil,
    kendi başına araştırma/tasarım gerektiren ayrı bir iş kalemi olarak
    ele alınmalı (madde 10'daki dev build ihtiyacını da güçlendiriyor).
