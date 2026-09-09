# Manuel Test Listesi — deneme-desktop

Bu liste, otonom oturumda **doğrulanamayan** (gerçek Windows/Electron
ortamı gerektiren) her şeyi kapsar. Sırayla dene.

## 0. Kurulum (ilk kez)

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
cd ..\..\deneme-server
npm run build          # dist/ üretir - deneme-desktop bunu file: bağımlılığı olarak kullanıyor
cd ..\deneme\deneme-desktop
npm install
```

**Önemli**: `deneme-server`'da kod her değiştiğinde `npm run build`
yeniden çalıştırılmalı — `deneme-desktop`, deneme-server'ın `dist/`
(derlenmiş) çıktısını kullanıyor, kaynağı canlı izlemiyor.

## 1. Geliştirme modunda çalıştırma

```powershell
npm run dev
```

- [ ] Bir Electron penceresi açılıyor mu (siyah/kırmızı tema, sol tarafta
      Bildirimler/Dosyalar/Aktarım/Sunucu sekmeleri)
- [ ] Pencere içeriği, tarayıcıda (`http://localhost:5183`) gördüğümle
      birebir aynı görünüyor mu (bu oturumda tarayıcıda doğrulandı,
      gerçek Electron penceresinde doğrulanmadı)
- [ ] Konsol'da (DevTools, Ctrl+Shift+I) kırmızı hata var mı

## 2. Sunucu paneli — temel akış

- [ ] "Sunucu" sekmesine geç
- [ ] "Klasör Seç" ile bir depo klasörü seç (ör. masaüstünde yeni boş bir
      klasör) — seçilen yol karta yazılıyor mu
- [ ] Port'u değiştirmeyi dene (varsayılan 4000) — sunucu DURDURULMUŞKEN
      düzenlenebilir olmalı
- [ ] "Başlat"a bas — "Çalışıyor: 0.0.0.0:4000" gibi bir durum görünmeli
- [ ] Aynı bilgisayardan bir tarayıcıda `http://localhost:4000/ping`'e
      git — `{"ok":true,...}` dönmeli
- [ ] "Durdur"a bas — durum "Durduruldu"ya dönmeli, `/ping` artık
      yanıt vermemeli

## 3. Cihaz eşleştirme (Sunucu panelinden)

- [ ] "Sunucu" sekmesinde "Yeni Cihaz Ekle" (+) butonuna bas
- [ ] Bir isim gir (ör. "Test Telefonu"), "Oluştur"a bas
- [ ] `{"deviceId":"...","token":"..."}` şeklinde tek satır bir kod
      görünmeli, "Kopyala" çalışmalı
- [ ] Bu kodu **mobile-app**'te (mobil) Aktarım → Cihaz Ekle ekranına
      yapıştırıp kaydet — mobil uygulama masaüstü sunucusuna
      `http://<bu-bilgisayarın-tailscale-ip'si>:4000` adresiyle
      bağlanabilmeli (Sunucu Ayarı ekranından adresi gir)
- [ ] Masaüstü Sunucu panelindeki "Eşleştirilmiş Cihazlar" listesinde bu
      yeni cihaz görünmeli, birkaç dakika içinde "Bağlı" olarak
      işaretlenmeli (mobil uygulama bir istek attığında)
- [ ] Listedeki "x" (çıkar) butonuyla cihazı sil — mobil uygulama bir
      sonraki istekte "yeniden eşleştir" ekranına düşmeli

## 4. İstemci rolü (Bildirimler/Dosyalar/Aktarım)

Bu üç sekme mobile-app'in EKRANLARIYLA AYNI KOD — ama kendi
sunucu bağlantı/kimlik bilgisi ayarına ihtiyaç duyuyor (Sunucu panelinin
YÖNETTİĞİ sunucudan bağımsız bir "hangi sunucuya bağlanıyorum" ayarı).

- [ ] Aktarım sekmesinde dişli (⚙) ikonuna bas → "Sunucu Adresi" ekranı
      açılmalı (aynı bu bilgisayarın kendi sunucusu olabilir:
      `http://127.0.0.1:4000`, ya da başka bir deneme-server)
- [ ] "+" ikonuna bas → "Cihazı Eşleştir" ekranı açılmalı, bir eşleştirme
      kodu yapıştır (yukarıdaki 3. adımda üretilen kodu kullanabilirsin —
      bu bilgisayar kendi kendine, farklı bir "cihaz kimliği" olarak
      bağlanmış olur)
- [ ] Dosyalar sekmesinde depo klasöründeki dosyalar/klasörler listelenmeli
- [ ] Bir dosya seçip "İndir" — **İndirme Klasörü** kartından (Dosyalar
      sekmesi) önce bir klasör seçilmiş olmalı; dosya o klasöre inmeli,
      dosya adı/uzantısı doğru olmalı, açılabilmeli
- [ ] Aktarım sekmesinde "Dosya Seç" (native Windows dosya seçici
      açılmalı) ile bir dosya seç, not yaz, "Yükle" — depo klasöründe
      dosyanın gerçekten oluştuğunu doğrula

## 5. Sistem tepsisi (tray)

- [ ] Pencereyi kapat (X) — uygulama TAMAMEN kapanmamalı, görev
      çubuğundan kaybolmalı ama tepsi (sistem saati yanı, ok işaretine
      tıkla) ikonunda kalmalı
- [ ] Sunucu "Başlat" durumundaysa, pencere kapatıldıktan SONRA da
      `/ping`'e yanıt vermeye devam etmeli (arka planda çalışıyor kanıtı)
- [ ] Tepsi ikonuna sağ tık → "Aç" ile pencere geri gelmeli
- [ ] Tepsi ikonuna çift tık ile de pencere açılmalı
- [ ] Tepsi menüsünden "Çıkış" — uygulama TAMAMEN kapanmalı (görev
      yöneticisinde electron.exe süreci kalmamalı), sunucu de durmalı

## 6. Windows açılışında otomatik başlama

- [ ] Sunucu panelinde "Windows açılışında otomatik başlat" kutucuğunu
      işaretle
- [ ] Bilgisayarı yeniden başlat (ya da oturumu kapat/aç)
- [ ] Uygulama kendiliğinden açılmalı (muhtemelen doğrudan tepsiye)
- [ ] Eğer sunucu daha önce "Başlat" durumunda bırakılmışsa, yeniden
      başlatma sonrası sunucu da OTOMATİK olarak çalışır duruma
      gelmeli (bilinçli tasarım: `serverAutoStart` bayrağı — "Başlat"a
      her basışta true, "Durdur"a her basışta false oluyor)

## 7. Paketleme (.exe üretimi) — SEN ÇALIŞTIRMALISIN

Bu adımı otonom oturum ÇALIŞTIRAMADI (gerçek bir Windows paketleme
çıktısı, imzasız bir .exe/kurulum sihirbazı üretir, bu sadece fiziksel
makinede anlamlı şekilde test edilebilir):

```powershell
cd <depo>\deneme\deneme-desktop
npm run package
```

- [ ] `release/` klasöründe bir `.exe` kurulum dosyası oluşmalı
- [ ] Kurulumu çalıştır (Windows SmartScreen "Yine de çalıştır" uyarısı
      verebilir — imzasız build olduğu için normal, bkz. oturum sonu
      raporu, kod imzalama bu turun kapsamı dışında bırakıldı)
- [ ] Kurulan uygulama masaüstünde/başlat menüsünde kısayol oluşturmalı
- [ ] Kurulan uygulamayı aç, yukarıdaki 1-6 arası adımları KURULU
      sürümde de tekrarla (geliştirme modundan farklı davranabilir —
      ör. dosya yolları, ikon, DevTools kapalı olmalı)

## 8. Bilinen/beklenen kısıtlamalar (bug değil)

- Bildirimler sekmesindeki bildirim listesi mobildeki gibi HER ZAMAN
  boş görünecek (sunucuda henüz gerçek bir bildirim/olay kaynağı yok —
  bu mobile-app oturumundan miras kalan, bilinçli bir durum)
- Bildirim kartlarında "kaydırarak silme" YOK — mobildeki swipe
  gesture'ı burada sürekli görünen bir "sil" butonuna dönüştürüldü
  (Reanimated'in worklet mekanizması bu Vite/esbuild toolchain'inde
  çalışmıyor, bkz. oturum sonu raporu)
- Dosya yükleme sırasında mobildeki gibi gerçek zamanlı yüzde ilerlemesi
  YOK (ana süreçteki fetch tabanlı yükleme XHR'ın verdiği ilerlemeyi
  sağlamıyor) — indirme ilerlemesi ise ÇALIŞIYOR olmalı (gerçek bayt
  sayımı ile)
