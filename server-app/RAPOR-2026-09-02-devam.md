# B7 Sonrası Kararlar, Test Altyapısı, Güvenlik ve Tasarım — Devam Raporu

Tarih: 2026-09-02 (RAPOR-2026-09-02.md'nin devamı). Kapsam: Görev 1-9
(açık kararları kapatma, otomatik test altyapısı, ek güvenlik denetimi,
`deneme-app` tasarım düzenlemesi, B7b/B8/D1 araştırmaları, C1 API uyum
denetimi, dokümantasyon). Hiçbir commit push edilmedi (talimat gereği son
adımda tek seferde push edilecek). Soru sorulmadı; belirsiz maddeler
Bölüm 6'da işaretlendi.

## 1. Görev 1 — Kapatılan kararlar

| Karar | Uygulama |
|---|---|
| a) Dosya boyutu sınırı | Eklenmedi (bilinçli, `multer`'da `limits.fileSize` yok); not için mevcut ~1 MB `fieldSize` sınırı korundu |
| b) Açılış temizliği | `upload.ts`'e `cleanupOrphanedTempUploads()` eklendi, `index.ts`'te sunucu dinlemeye başlamadan önce çağrılıyor, silinen dosya sayısı konsola yazılıyor, hata olursa sunucu yine de açılıyor. Canlı test edildi: 2 kalıntı dosya → "2 kalıntı dosya silindi" logu, `.tmp-uploads` boşaldı |
| c) "Hepsi ya da hiçbiri" | Değiştirilmedi — `routes/files.ts`'teki mevcut rollback (`committed` listesini geri alma) davranışı aynen korundu |
| d) `indirilen.jpg` | Silindi (repoda hiç izlenmiyordu, `git status`'ta artık görünmüyor) |
| e) `STORAGE_ROOT` varsayılanı | `config.ts`'ten `"E:\\deneme-storage"` kaldırıldı; değişken tanımlı değilse `console.error` + `process.exit(1)`. Canlı test edildi: değişken silinince süreç net mesajla çıktı (exit code 1) |

## 2. Görev 2 — Otomatik test altyapısı

- **55 test**, `node:test` + `node:assert` ile (`tsx --test`), yeni test
  kütüphanesi kurulmadı.
- Kapsam: `/ping`, `/api/devices` (header'lı/header'sız), `/api/files`
  (kök/alt/iç-içe/boş/olmayan/dosya-olarak-path/depo-dışı/meta-gizleme),
  `/api/files/download` (Range'siz, kısmi, çoklu aralık, bozuk sözdizim,
  aşan start, 0 bayt, path yok, olmayan dosya, klasör, depo dışı),
  `/api/files/upload` (tüm B7 senaryoları — çoklu dosya, çakışma
  numaralandırma, path traversal, ADS, uzantı-only, boş ad, 255+ karakter,
  Türkçe, emoji, yasak karakter, rezerve adlar, 0 bayt), ve önceki
  oturumda düzeltilen **6 hatanın her biri için ayrı regresyon testi**
  (`test/regression.test.ts`).
- Her test dosyası kendi geçici deposunu (`os.tmpdir()` altında) ve
  rastgele bir portu kullanıyor, sonunda süreci `taskkill /T /F` ile
  (Windows'ta işlem ağacı tamamen) kapatıp deposunu `fs.rm` ile
  (yeniden-denemeli, Windows'un geç handle bırakma davranışına karşı)
  siliyor.
- **Sonuç: 55/55 geçiyor**, gerçek `E:\deneme-storage`'a hiç dokunulmadı
  (bkz. Bölüm 7).

## 3. Görev 3 — Kalan güvenlik denetimi (9 madde)

| Madde | Sonuç |
|---|---|
| a) Gerçek symlink (dosya/klasör) | Bu makinede Geliştirici Modu/yükseltilmiş izin olmadığından oluşturulamadı (EPERM) — test bunu tespit edip atlıyor. Aynı `fs.realpath` tabanlı korumadan geçmesi beklenir (junction ile birebir aynı kod yolu) ama bu makinede doğrulanamadı |
| b) Sondaki nokta/boşluk | Güvenli, sorunsuz |
| c) NFC/NFD normalizasyon | **Hata bulundu ve düzeltildi** — görünüşte aynı, farklı kod noktalı iki ad ayırt edilemeyen iki dosya oluşturuyordu. `sanitizeFileName` artık NFC'ye normalleştiriyor |
| d) MAX_PATH (260 char) | Güvenli — 541 karakterlik tam yolla test edildi, 200 döndü |
| e) Notta kontrol karakteri/null bayt | Güvenli — `JSON.stringify` zaten kaçışlıyor |
| f) `<ad>.meta.json` yükleme | Güvenli — mevcut çakışma numaralandırması gerçek meta dosyasının üzerine yazılmasını engelliyor, sonuç listede görünür kalıyor |
| g) CRLF enjeksiyonu | Güvenli — sanitizasyon zaten kontrol karakterlerini temizliyor |
| h) URL-kodlanmış traversal | Etkisiz, güvenli |
| i) Sadece boşluk/nokta ad | Güvenli |

**1 gerçek hata** (c), test ve düzeltmeyle birlikte `test/security-extra.test.ts`'e eklendi.

## 4. Görev 4 — deneme-app tasarım düzenlemesi

**Tespit edilen tasarım kuralları** (`constants/app-theme.ts` + 3 ekran
incelenerek çıkarıldı):
- Köşe yarıçapı ölçeği: 8 (küçük ikon kutuları) / 12–13 (buton, satır,
  arama çubuğu) / 16 (kart) / 20 (Aktarım kartı) / 999 (tam yuvarlak: pil,
  ilerleme çubuğu, nokta göstergesi)
- Boşluk ölçeği: 4 / 6 / 8 / 9 / 10 / 12 / 14 / 20 (ekran yatay dolgusu)
- Tipografi: başlık 24/700, alt başlık 12/500, gövde 11–13.5/600–700,
  etiket 9.5–10.5/700–800 (harf aralığı ile), buton 15–15.5/700–800
- İkon boyutu: 12 (küçük rozet) / 15–19 (satır içi) / 26–30 (ana eylem)
- Renk: tamamen `constants/app-theme.ts`'teki `AppTheme` token'ları
  üzerinden (`t.bg`, `t.accent`, `t.helperWarn` vb.); koyu temada kırmızı
  (`#d81e28`), açık temada mavi (`#2563eb`) vurgu — **değiştirilmedi**

**Yapılan değişiklikler** (dosya:satır — commit `c39ea96`):
- Sabit `'#fff'` → `t.onAccent`: [aktarim.tsx:275](deneme-app/app/(tabs)/aktarim.tsx#L275) (toast ikonu), [aktarim.tsx:336](deneme-app/app/(tabs)/aktarim.tsx#L336) (dosya rozeti metni). *Gerekçe:* `t.onAccent` her iki temada da zaten `#ffffff` — görsel sonuç aynı, sadece tema sistemine bağlandı.
- 38×38 tema/yenile butonları ve 22×22 onay kutusu: `hitSlop` eklendi
  ([index.tsx](deneme-app/app/(tabs)/index.tsx), [explore.tsx](deneme-app/app/(tabs)/explore.tsx), [aktarim.tsx](deneme-app/app/(tabs)/aktarim.tsx)). *Gerekçe:* görünür boyutu değiştirmeden (tasarım dili korunur) dokunma alanını ~44×44'e çıkarmanın React Native'deki standart yolu.
  Tüm etkileşimli `Pressable`/`TextInput`'lara `accessibilityRole`/
  `accessibilityLabel`/`accessibilityState` eklendi.
- Hata rengi tutarlılığı: "Sunucuya ulaşılamıyor" banner'ları ve Aktarım
  ekranının durum başlığı/ipucu, marka rengi `t.accent` yerine anlamsal
  olarak doğru `t.helperWarn` kullanacak şekilde değiştirildi
  ([index.tsx](deneme-app/app/(tabs)/index.tsx), [explore.tsx](deneme-app/app/(tabs)/explore.tsx), [aktarim.tsx](deneme-app/app/(tabs)/aktarim.tsx)). *Gerekçe:* önceden açık temada hata banner'ı mavi (marka rengiyle aynı) görünüyordu, alarm niteliği taşımıyordu; palet değerlerine dokunulmadı, sadece hangi token kullanıldığı düzeltildi.
- Boş durum metinleri: "Henüz dosya yok" → Aktarım sekmesine yönlendiren
  ipucu; "Henüz bildirim yok" → ne zaman dolacağını açıklayan ipucu.
  Düzen korundu, sadece metin/hiyerarşi eklendi.
- Yükleniyor durumuna `ActivityIndicator` eklendi (`explore.tsx`) —
  önceden yalnızca "Yükleniyor…" metni vardı.
- Cihaz çipindeki uzun isimler artık taşmadan kırpılıyor
  (`numberOfLines` + `maxWidth`, `explore.tsx`).

**Doğrulama:** `npx tsc --noEmit` temiz; Expo web önizlemesi
(`expo start --web`) üzerinden hem koyu hem açık temada, üç ekranda da
görsel olarak kontrol edildi (ekran görüntüleri bu oturumda alındı,
düzen/renk/metin beklendiği gibi).

**Bilinçli dokunulmayan:** `components/themed-text.tsx`,
`components/themed-view.tsx`, `app/modal.tsx`, `constants/theme.ts` —
bunlar Expo'nun varsayılan şablonundan kalma, **kullanılmayan** ölü kod
(gerçek 3 ekran bunları hiç import etmiyor, kendi `constants/app-theme.ts`
sistemini kullanıyor). `themed-text.tsx`'te bir sabit renk (`#0a7ea4`)
daha var ama bu dosya üründe hiç çalışmadığından ve tamamen farklı,
kullanılmayan bir tema sistemine ait olduğundan kapsam dışı bırakıldı
(bkz. Bölüm 6).

## 5. Görev 5-8 — Araştırma özetleri

- **[ARASTIRMA-B7b.md](ARASTIRMA-B7b.md)** — Devam ettirilebilir yükleme
  için tus, Content-Range/PUT ve kendi chunk protokolümüz karşılaştırıldı;
  mevcut multer mimarisine en az sürtünmeyle **kendi chunk protokolümüzün**
  oturduğu sonucuna varıldı (multer'ı hiç değiştirmeden her parça normal
  bir multipart POST olarak işlenebilir). expo-file-system'in resumable
  desteğinin **sadece indirmede** olduğu, yüklemede olmadığı Expo'nun
  resmi v54.0.0 dokümantasyonundan doğrulandı.
- **[ARASTIRMA-B8.md](ARASTIRMA-B8.md)** — Token üretimi (crypto.randomBytes),
  dosya-tabanlı hash'li saklama, üç eşleştirme yöntemi (elle/QR/kısa kod,
  her biri kullanıcı adımlarıyla), `expo-secure-store` önerisi,
  `Authorization: Bearer` başlığının query param'a tercih edilme
  gerekçesi ve Tailscale'in üstüne token'ın somut olarak ne kattığı
  (ağ üyeliği ≠ uygulama yetkisi) analiz edildi.
- **[ARASTIRMA-D1.md](ARASTIRMA-D1.md)** — Electron/Tauri/React Native
  for Windows karşılaştırıldı; **Electron** önerildi çünkü Express
  sunucusu onun Node.js ana sürecinde doğrudan çalışabiliyor ve mobil
  ekranlar `react-native-web` ile (bu oturumda bizzat doğrulanmış şekilde)
  neredeyse değişmeden taşınabiliyor; RNW'nin Expo modül desteği
  belirsizliği ve MSIX'in teknik olmayan kullanıcılar için kurulum
  sürtünmesi risk olarak işaretlendi.
- **[C1-HAZIRLIK.md](C1-HAZIRLIK.md)** — `services/api.ts` gerçek sunucu
  API'siyle karşılaştırıldı: `getFiles()` yanıt zarfını yanlış çözüyor ve
  tamamen farklı bir veri modeli (iç-içe ağaç) bekliyor, indirme eski bir
  URL biçimi kullanıyor, `targetPath` ve `X-Device-Id` hiç gönderilmiyor,
  `API_BASE_URL` sabit kodlanmış — 10 maddelik bir C1 iş listesi (dev
  build ve foreground service ihtiyaçları dahil) çıkarıldı.

## 6. Karar gerektirenler

1. **Görev 3a (gerçek symlink testi)** — bu makinede Windows Geliştirici
   Modu/yükseltilmiş izin olmadığından dosya/klasör symlink'i
   oluşturulamadı, test EPERM ile atlandı. Junction ile birebir aynı
   savunma kodu (`fs.realpath` karşılaştırması) kullanıldığından risk
   düşük değerlendiriliyor ama bu makinede ampirik olarak doğrulanamadı.
2. **`fixFileNameEncoding`'in sezgisel oluşu** (önceki oturumdan miras,
   bu oturumda değiştirilmedi) — latin1→utf8 yeniden kodlaması yalnızca
   sonuç geçerliyse uygulanıyor; çok nadir bir kenar durumda zaten doğru
   kodlanmış bir adı yanlış tetikleyebilir teorik riski var.
3. **`components/themed-text.tsx` içindeki sabit renk (`#0a7ea4`)**
   düzeltilmedi — bu dosya ürünün gerçek 3 ekranından hiçbiri tarafından
   kullanılmıyor, Expo şablonundan kalma ölü kod ve tamamen farklı
   (`constants/theme.ts`) bir tema sistemine ait. Silinmesi/temizlenmesi
   ayrı bir "ölü kod temizliği" kararı olarak kullanıcıya bırakıldı.
4. **B7b/B8/D1 için hangi yaklaşımın seçileceği** — üç araştırma belgesi
   de bir öneri sunuyor ama nihai seçim (ör. tek-token mı cihaz-başına
   token mı, chunk protokolü mü tus mu, Electron mı Tauri mı) kullanıcıya
   bırakıldı; hiçbiri için kod yazılmadı (talimat gereği).
5. **C1 iş listesindeki madde 9** (sunucunun listeleme yanıtının
   `note`/`uploadedBy` döndürmemesi) — mobil uygulama bu bilgiyi
   göstermek isterse, bu C1'in mobil kapsamının dışında, ayrı bir
   **sunucu** görevi gerektirir; burada ele alınmadı.

## 7. Son kontroller

- `npx tsc --noEmit` — **deneme-server**: temiz. **deneme-app**: temiz.
- `npx tsc -p tsconfig.test.json --noEmit` (test klasörü dahil) — temiz.
- `npm test` (deneme-server) — **55/55 geçti**.
- `git status --porcelain`:
  - `deneme-server`: yalnızca bu rapor ve güncellenmiş `README.md`
    (commit'lenmemiş, bu görevin bir parçası).
  - `deneme` (mobil repo): yalnızca `.claude/`/`.idea/` (IDE klasörleri,
    commit edilmeyecek).
- **`E:\deneme-storage`** — oturum başındaki ve sonundaki dosya/klasör
  zaman damgaları birebir aynı (yukarıda karşılaştırıldı); bu oturumdaki
  hiçbir test veya işlem gerçek depoya dokunmadı.
