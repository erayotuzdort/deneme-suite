# Araştırma: D1 — Masaüstü Teknolojisi

## KARAR VERİLDİ (bkz. deneme-desktop inşa turu, 2026-09-03)

Aşağıdaki araştırma bu turda kesinleştirildi ve `deneme-desktop` bu
kararlarla inşa edildi (depo kökünün yanındaki `deneme-desktop` klasörü):

- **(a) Çatı:** Electron seçildi — aşağıdaki (a) bölümündeki gerekçe
  aynen geçerli kaldı. Sunucu (deneme-server) Electron'un ana sürecinde
  DOĞRUDAN çalışıyor (ayrı bir child_process DEĞİL) — bu, aşağıdaki
  (c) bölümündeki önceki "ayrı süreç" önerisinden BİLİNÇLİ bir sapma:
  sistem tepsisi (tray) entegrasyonu eklendiği için "pencere kapanınca
  sunucu ölür" endişesi artık geçersiz (pencere kapatılınca uygulama
  TAMAMEN kapanmıyor, tray'e küçülüyor, aynı süreçteki sunucu
  çalışmaya devam ediyor) — ayrı süreç yönetiminin (başlatma/çökme
  sonrası yeniden başlatma/temiz kapatma) getirdiği ek karmaşıklığa
  gerek kalmadı.
- **(b) Kod taşınabilirliği:** Aşağıdaki (b) bölümündeki tahminler
  BÜYÜK ÖLÇÜDE doğrulandı (react-native-web ile ekranlar gerçekten
  neredeyse değişmeden çalıştı) — ama iki önemli fark ortaya çıktı,
  gelecekte bu araştırmayı tekrar açacak biri için not:
  1. `react-native-reanimated` (v4) VE `react-native-gesture-handler`'ın
     `ReanimatedSwipeable`'ı, worklet mekanizmaları bir BABEL plugin'ine
     bağımlı olduğundan Vite/esbuild tabanlı bu toolchain'de (Metro
     değil) HİÇ ÇALIŞMADI — modül import edilir edilmez çöküyordu.
     Bildirimler ekranındaki swipe-to-dismiss, sürekli görünen bir "sil"
     butonuna dönüştürülerek (aynı ekran kodu değişmeden, sadece
     `react-native-gesture-handler/ReanimatedSwipeable` ve
     `react-native-reanimated` Vite alias'ıyla masaüstüne özgü
     shim'lere yönlendirilerek) çözüldü.
  2. `expo-router` ve `@expo/vector-icons` gibi Expo'ya özgü paketler
     hiç kurulmadı — bunlar da alias'lanan küçük shim'lerle karşılandı
     (state-tabanlı basit navigasyon, react-icons/io5 tabanlı ikonlar).
- **(c) Sunucu kod paylaşımı — bu araştırmada hiç ele alınmamış bir
  soru, bu turda karara bağlandı:** npm `file:` bağımlılığı
  (`"deneme-server": "file:../../deneme-server"`), deneme-server'ın
  DERLENMİŞ (`dist/`) çıktısı üzerinden. Gerekçe: gerçek npm workspaces
  iki ayrı, bağımsız git repo'sunu tek bir monorepo köküne taşımayı
  gerektirirdi (istenmedi) - `file:` protokolü, repoların ayrı
  kalmasına izin verirken gerçek kod paylaşımı sağlıyor (auth/pairing/
  cihaz mantığı kopyalanmadı). Bunu çalıştırmak için deneme-server'a
  küçük, geriye dönük uyumlu refactor'lar yapıldı: `config.ts` artık
  import anında process.exit etmiyor (mutable + `configureFromEnv()`),
  `index.ts` `createApp()`/`runStartupCleanup()` dışa aktarıyor
  (`require.main === module` korumalı, CLI davranışı aynı kaldı),
  `package.json`'a `exports` haritası + `declaration: true` eklendi.
  Detay için deneme-server'daki ilgili commit'lere bakın.

---


Bu belge yalnızca araştırma içindir, kod içermez. Bağlam: tek kod tabanı,
iki sürüm. **Sunucu sürümü** masaüstü istemci işlevlerinin hepsine sahip,
üstüne sunucu yönetimi (depo klasörü seçimi, port, başlat/durdur, bağlı
cihazlar, token yönetimi). **Normal sürüm** sadece dosya indirme/yükleme,
mobildekiyle aynı tasarım.

**Önemli kanıt:** Görev 4 sırasında `deneme-app`'in mevcut hâli
`expo start --web` ile hiçbir değişiklik yapılmadan tarayıcıda çalıştırıldı
ve üç ekranın da (Bildirimler/Dosyalar/Aktarım) doğru render olduğu,
navigasyonun, ikonların ve tema geçişinin sorunsuz çalıştığı gözlemle
doğrulandı — bu, aşağıdaki `react-native-web` tabanlı kod paylaşımı
önerisini kanıta dayandırıyor.

## a) Electron vs Tauri vs React Native for Windows

| | Electron | Tauri | React Native for Windows |
|---|---|---|---|
| Kurulum boyutu | Büyük (~150–200 MB+, kendi Chromium'unu taşır) | Küçük (~3–10 MB, Windows'un yerleşik WebView2'sini kullanır) | En küçük (gerçek native UI, tarayıcı motoru yok) |
| RAM | Yüksek (her uygulama kendi Chromium'unu çalıştırır) | Düşük (paylaşılan sistem WebView2) | En düşük (native render) |
| Mobil kodun yeniden kullanımı | **Yüksek** — `react-native-web` zaten projede var, ekranlar neredeyse değişmeden çalışır (yukarıdaki kanıt) | Aynı (`react-native-web` ile) — WebView farklı ama HTML/CSS/JS katmanı aynı | Teoride en yüksek (gerçek RN), pratikte **belirsiz**: Expo modülleri (`expo-document-picker`, `expo-file-system`, `expo-haptics` vb.) Windows'ta resmi/olgun destek sunuyor mu, doğrulanmadı — büyük risk |
| Sunucu (Node/Express) entegrasyonu | **Doğal** — Electron'un ana süreci zaten Node.js, `deneme-server` doğrudan `require`/import edilip aynı süreçte çalıştırılabilir | Native katman Rust — Node sunucusu ancak "sidecar" (paketlenmiş ayrı bir çalıştırılabilir) olarak dışarıdan başlatılabilir, doğrudan gömülemez | Aynı Tauri gibi — RNW'nin native katmanı C++/C#, Node sunucusu yine ayrı bir süreç olarak yönetilmeli |
| Windows'a entegrasyon (servis, sistem tepsisi) | İyi belgelenmiş (`app.setLoginItemSettings`, tray API) | Benzer, eklenti üzerinden (`tauri-plugin-autostart`) | En native ama en az "hazır" araç; native Windows proje bilgisi gerekir |
| Dağıtım | `electron-builder` ile olgun .exe/MSI üretimi | `tauri build` ile küçük MSI/NSIS üretimi | Genellikle MSIX (yan yükleme için geliştirici modu/sertifika güveni gerekir — teknik olmayan kullanıcı için ekstra sürtünme) |
| Geliştirme hızı (bu proje için) | Yüksek — mevcut TS/React bilgisi doğrudan geçerli | Orta — UI tarafı aynı ama Rust köprüsü öğrenme eğrisi ekler | Düşük/belirsiz — native Windows araç zinciri (Visual Studio, Windows SDK) kurulum ve bakım yükü en ağır olanı |

**Öneri: Electron.** Gerekçe: (1) `deneme-server`'ın Express kodu
Electron'un ana sürecinde hiçbir uyarlama gerekmeden çalışabilir — bu,
Tauri/RNW'de sidecar/ayrı süreç paketleme gerektiren bir şeyi bedavaya
getirir; (2) mobil ekranların `react-native-web` üzerinden yeniden
kullanımı zaten bu oturumda kanıtlandı; (3) Electron'un büyük
boyut/RAM dezavantajı, kaynağı kısıtlı bir cihaz değil "gerçek" bir ev
bilgisayarında çalışacak bir sunucu-uygulaması için görece önemsiz;
(4) tek geliştiricinin bakabileceği en az sürtünmeli araç zinciri.
Tauri, boyut/RAM açısından daha iyi olsa da Node sunucusunu sidecar
olarak paketlemek ekstra karmaşıklık katıyor. RNW'nin Expo modül
desteği belirsizliği, bu projenin (belgeleyici seçici, dosya sistemi
gibi) tam da kullandığı modüllerde risk taşıyor.

## b) deneme-app'in kodunun ne kadarı taşınabilir?

**Değişmeden çalışması beklenen (react-native-web üzerinden, doğrulandı):**
- `constants/app-theme.ts` — saf TS/JS nesneleri, platform bağımsız
- `contexts/theme-context.tsx`, `notifications-context.tsx`,
  `device-context.tsx` — saf React mantığı + `useColorScheme`
  (react-native-web'de de var)
- `app/(tabs)/index.tsx`, `explore.tsx`, `aktarim.tsx` — `View`/`Text`/
  `Pressable`/`ScrollView`/`TextInput`/`StyleSheet`/`Animated`'ın hepsinin
  react-native-web karşılığı var; bu oturumda tarayıcıda çalıştığı
  görüldü
- `services/api.ts` — `fetch` tabanlı, tamamen platform bağımsız
- `@expo/vector-icons` (Ionicons) — web font/SVG karşılığı var, bu
  oturumda ikonlar doğru render oldu
- `expo-router` + `@react-navigation/bottom-tabs` — web desteği var, sekme
  navigasyonu bu oturumda test edilip çalıştığı görüldü

**Doğrulanması/uyarlanması gerekenler:**
- `expo-document-picker` (Aktarım ekranındaki dosya seçici) — web
  implementasyonu tarayıcının `<input type="file">`'ını kullanır; Electron
  Chromium tabanlı olduğu için MUHTEMELEN çalışır ama doğrulanmadı
- `expo-haptics` (`components/haptic-tab.tsx`) — masaüstünde anlamsız,
  web implementasyonu no-op olmalı, kontrol edilmeli

**Tamamen yeni yazılması gerekenler (mobilde karşılığı yok):**
- Depo klasörü seçici (native klasör diyaloğu — Electron'da
  `dialog.showOpenDialog`)
- Sunucu başlat/durdur, port ayarı, sistem tepsisi/açılışta başlatma
  arayüzü
- Express sunucusunun Electron ana sürecine (ya da ayrı bir alt sürece,
  bkz. madde c) gömülmesini sağlayan bağlama kodu

## c) Sunucu, masaüstü uygulamasının İÇİNDE mi yoksa AYRI süreç olarak mı?

**Aynı süreçte (Electron ana süreci Express'i doğrudan çalıştırır):**
- Artı: en basit mimari, tek süreç, yönetim arayüzünden sunucu durumuna
  doğrudan bellek-içi erişim (IPC gerekmez).
- Eksi: yönetim penceresi kapanır/çökerse sunucu da ölür — "arka planda
  sürekli açık dosya sunucusu" beklentisiyle çelişir. Electron'un kendi
  gömülü Node sürümüne bağımlı kalınır.

**Ayrı süreç (Electron, `deneme-server`'ı bir alt süreç olarak
başlatır/izler; yönetim arayüzü ona normal bir HTTP istemcisi gibi
`127.0.0.1:<port>` üzerinden konuşur):**
- Artı: sunucu, yönetim penceresi kapatılsa/simge durumuna küçültülse
  bile çalışmaya devam edebilir — görevde açıkça istenen "başlat/durdur"
  kontrolleriyle daha tutarlı bir model. Sürüm/bağımlılık ayrımı temiz
  kalır.
- Eksi: süreç yönetimi (başlatma, çökme durumunda yeniden başlatma,
  temiz kapatma) elle yazılmalı.

**Öneri: ayrı süreç.** Görevde tarif edilen "başlat/durdur" kontrollerinin
varlığı, sunucunun yönetim penceresinden bağımsız bir yaşam döngüsü
olması gerektiğini ima ediyor.

## d) Windows'a servis olarak otomatik başlatma

Üç seçenekte de çerçeve, gerçek bir Windows Servisi (oturum açılmadan da
çalışan, arka planda) kaydını **kendiliğinden sağlamıyor**:

- **Electron:** `app.setLoginItemSettings({ openAtLogin: true })` ile
  "oturum açılışında başlat" (uygulamanın kendisi, sistem tepsisi
  ikonuyla) kolayca yapılır — ama bu, kullanıcı oturum açana kadar
  çalışmaz. Gerçek, oturumsuz servis davranışı için sadece Express
  sunucusunu saran ayrı bir native Windows Servisi (ör. `node-windows`
  paketiyle) gerekir.
- **Tauri:** Aynı desen, `tauri-plugin-autostart` ile. Gerçek servis
  davranışı yine ayrı bir sarmalayıcı gerektirir.
- **React Native for Windows:** Framework'ün hazır bir "oturum açılışında
  başlat" API'si yok; Başlangıç klasörü kısayolu ya da Görev Zamanlayıcı
  girdisi gibi standart Windows mekanizmaları elle kurulmalı — üçü
  arasında en az "hazır çözüm" sunan.

**Sonuç:** Hangi arayüz çatısı seçilirse seçilsin, "gerçek Windows
Servisi" ihtiyacı ayrı, küçük bir Node tabanlı servis sarmalayıcısıyla
çözülüyor — bu, arayüz teknolojisi seçiminden bağımsız bir iş.

## e) Kurulum paketi (installer) nasıl üretilir?

- **Electron:** `electron-builder` — NSIS tabanlı `.exe` ya da `.msi`,
  imzalama ve otomatik güncelleme (`electron-updater`) desteğiyle; olgun
  ve iyi belgelenmiş.
- **Tauri:** `tauri build` (CLI'ya gömülü) — NSIS/WiX tabanlı `.msi`,
  Electron eşdeğerlerinden daha küçük çıktı, resmi güncelleyici eklentisi
  mevcut.
- **React Native for Windows:** Genellikle **MSIX** paketleme (Visual
  Studio paketleme projesi ya da `react-native run-windows --release`).
  MSIX'in yan yükleme (sideload) ile kurulması, hedef makinede
  "Geliştirici Modu"nun açılmasını ya da bir sertifikaya güvenilmesini
  gerektirir — **bu oturumda symlink testi için tam olarak aynı türde bir
  engelle (yükseltilmiş izin/geliştirici modu gerekliliği) karşılaşıldı**;
  teknik bilgisi olmayan bir aile üyesi için bu ekstra adım gerçek bir
  kurulum engelidir.

**Sonuç:** Kurulum kolaylığı açısından da Electron/Tauri (tek tıkla
çalışan klasik `.exe`/`.msi`), MSIX yan yüklemesinin ekstra adımlarına
göre hedef kitle (teknik bilgisi olmayan aile üyeleri) için daha uygun.
