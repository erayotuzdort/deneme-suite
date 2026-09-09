import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';
import { rnw } from 'vite-plugin-rnw';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { dependencies?: Record<string, string> };

// Ana süreç bağımlılıklarını (deneme-server dahil) Rollup'a GÖMDÜRMÜYORUZ -
// dışarıda (external) bırakıp Node'un KENDİ require/import çözümlemesine
// devrediyoruz. Sebep: Rollup'ın CJS->ESM bundling'i, deneme-server'ın tsc
// çıktısındaki CJS deseniyle güvenilir çalışmıyordu ("exports is not defined
// in ES module scope" - ham CJS içeriği ESM bağlamına gömülüyordu). node_modules
// üzerinden gerçek bir paket olarak bırakmak, Node'un olgun/doğru CJS-ESM
// interop'unu (statik analiz değil, gerçek runtime çözümleme) devreye sokuyor.
const externalDependencyNames = Object.keys(pkg.dependencies ?? {});
// String eşleşmesi TAM eşleşme arıyor - "deneme-server" listede olsa da
// "deneme-server/config" gibi ALT YOLLAR (electron/main/server.ts'in
// kullandığı) buna dahil olmuyordu ve yine gömülüyorlardı. Bu yüzden bir
// fonksiyonla önek eşleşmesi de kapsanıyor.
function isExternalDependency(id: string): boolean {
  return externalDependencyNames.some((dep) => id === dep || id.startsWith(`${dep}/`));
}

// mobile-app'in ekranlarını (app/(tabs)/*.tsx) ve paylaşılan context/theme
// dosyalarını DOĞRUDAN (kopyalamadan) yeniden kullanmak için, mobile-app'in
// kendi "@/*" alias'ını burada da tanımlıyoruz - ama sadece services/api,
// apiConfig, credentials, sharedStorage için DAHA SPESİFİK üç alias önce
// eşleşiyor (Vite ilk eşleşen alias'ı kullanır), böylece bu dört modülün
// mobil (Expo'ya özgü: SecureStore/AsyncStorage/MediaLibrary/SAF) sürümleri
// yerine buradaki Electron sürümleri devreye giriyor - ekranların kendi
// kodu HİÇ değişmeden.
const DENEME_APP_ROOT = path.resolve(__dirname, '../mobile-app');

export default defineConfig(({ command }) => {
  rmSync('dist-electron', { recursive: true, force: true });
  rmSync('dist', { recursive: true, force: true });

  const isServe = command === 'serve';

  return {
    server: {
      port: 5183,
      strictPort: true,
    },
    build: {
      rollupOptions: {
        output: {
          // Renderer tek parça 1,26 MB'lık bir dosyaydı; React ve
          // react-native-web nadiren değiştiğinden kendi parçalarına
          // ayrılıyor - açılışta ayrıştırılacak uygulama kodu küçülüyor ve
          // yeniden derlemelerde bu parçalar önbellekte kalabiliyor.
          manualChunks: {
            react: ['react', 'react-dom'],
            'react-native-web': ['react-native-web'],
          },
        },
      },
      // Yukarıdaki bölmeden sonra kalan parçalar eşiğin altında; uyarı
      // eşiğini gerçekçi bir yere çekiyoruz ki gerçek bir şişme fark edilsin.
      chunkSizeWarningLimit: 700,
    },
    resolve: {
      // react-native-web + doğrudan react/react-dom bağımlılığı birlikte -
      // Rollup, react-native-web'in KENDİ iç çözümleme yolundan gelen react
      // importunu, uygulamanın doğrudan "react" importundan AYRI bir modül
      // olarak paketleyebiliyor (aynı node_modules/react/ dosyasına işaret
      // etseler bile) - sonuç: react'in çekirdek kodu (ReactCurrentDispatcher
      // vb.) bundle'da BİRDEN FAZLA kopya olarak yer alıyor, iki kopya
      // arasında hook state paylaşılmadığından "Cannot read properties of
      // null (reading 'useState')" ile çöküyor (react-native-web'de bilinen
      // bir sınıf hata - GH #2668). dedupe, Rollup'ı TÜM importlar için AYNI
      // tek react/react-dom modül kaydını kullanmaya zorluyor.
      // react-native-safe-area-context da AYNI sınıf sorunu yaşıyor - paket
      // hem lib/commonjs/SafeAreaContext.js hem lib/module/SafeAreaContext.js
      // olarak iki paralel build şekli sağlıyor; farklı importlar farklı
      // dosyaya çözümlenince Rollup ikisini AYRI modül sayıyor, her biri
      // kendi React.createContext()'ini kuruyor - <SafeAreaProvider> bir
      // context nesnesine yazarken useSafeAreaInsets() diğerinden okuyor,
      // "No safe area value available" ile çöküyor (Provider App.tsx'te zaten
      // var - eksik değil, görünmüyor).
      // react-native-web'in KENDİSİ de aynı sınıf risk taşıyor
      // (main:dist/cjs/index.js, module:dist/index.js - iki ayrı dosya) ve
      // Dimensions/Animated/StyleSheet gibi singleton-benzeri iç modüller
      // barındırıyor - sistematik taramada "No dimension set for key"
      // (Dimensions modülünün imzası) bundle'da 2 kez bulundu, doğrulanmış
      // duplikasyon.
      dedupe: ['react', 'react-dom', 'react-native-safe-area-context', 'react-native-web'],
      alias: [
        { find: '@/services/api', replacement: path.resolve(__dirname, 'src/services/api.ts') },
        { find: '@/services/apiConfig', replacement: path.resolve(__dirname, 'src/services/apiConfig.ts') },
        { find: '@/services/credentials', replacement: path.resolve(__dirname, 'src/services/credentials.ts') },
        { find: '@/services/sharedStorage', replacement: path.resolve(__dirname, 'src/services/sharedStorage.ts') },
        { find: '@/services/localStore', replacement: path.resolve(__dirname, 'src/services/localStore.ts') },
        { find: 'expo-router', replacement: path.resolve(__dirname, 'src/shims/expo-router.tsx') },
        { find: 'expo-document-picker', replacement: path.resolve(__dirname, 'src/shims/expo-document-picker.ts') },
        { find: '@expo/vector-icons/Ionicons', replacement: path.resolve(__dirname, 'src/shims/Ionicons.tsx') },
        // react-native-reanimated ve ReanimatedSwipeable şimleri KALDIRILDI:
        // ikisini de yalnızca mobile-app'in (tabs)/index.tsx ve _layout.tsx
        // dosyaları import ediyor, masaüstü ise o iki dosyayı hiç monte
        // etmiyor (App.tsx yalnızca explore, aktarim, pair-device,
        // server-settings ekranlarını kullanıyor + kendi BildirimlerScreen'i).
        // Derlenmiş bundle'da şimlerin imza dizgileri bulunamadı - ölü koddu.
        { find: '@', replacement: DENEME_APP_ROOT },
      ],
    },
    plugins: [
      // rnw() kendi React/JSX (otomatik runtime) transform'unu içeriyor -
      // ayrıca @vitejs/plugin-react eklemek Fast Refresh'i iki kez enjekte
      // edip esbuild'de "sembol zaten tanımlı" hatasına yol açıyordu.
      rnw(),
      electron({
        main: {
          entry: 'electron/main/index.ts',
          vite: {
            build: {
              outDir: 'dist-electron/main',
              sourcemap: isServe,
              minify: !isServe,
              // package.json "type":"module" iken varsayılan .js çıktısı
              // Node'u kafa karıştırıp CJS içerikli bir dosyayı ESM sanıp
              // patlatıyordu ("exports is not defined in ES module scope").
              // preload zaten .mjs alıyordu (çalışıyordu) - main'i de aynı
              // şekilde açıkça ESM + .mjs'e zorluyoruz.
              rollupOptions: {
                external: isExternalDependency,
                output: {
                  format: 'es',
                  entryFileNames: '[name].mjs',
                },
              },
            },
          },
        },
        preload: {
          input: path.join(__dirname, 'electron/preload/index.ts'),
          vite: {
            build: {
              outDir: 'dist-electron/preload',
              sourcemap: isServe ? 'inline' : false,
              minify: !isServe,
              // main'deki AYNI sorun preload'da da vardı (bkz. main.rollupOptions
              // yorumu): vite-plugin-electron burada AÇIKÇA belirtilmezse
              // preload'ı CJS içerikle ("require(...)") üretiyor ama dosyayı
              // yine de üst package.json'daki "type":"module" yüzünden .mjs
              // adlandırıyor - Electron .mjs'i ESM yükleyicisiyle açıyor, ESM'de
              // global require YOK, preload "ReferenceError: require is not
              // defined in ES module scope" ile SESSİZCE çöküyor (Electron
              // preload hatasını sadece webContents 'preload-error' event'iyle
              // bildiriyor, varsayılan konsola basmıyor) ve
              // contextBridge.exposeInMainWorld hiç çalışmıyor - renderer'da
              // window.desktop sürekli undefined kalıyor ("Masaüstü köprüsü
              // yüklenemedi" ekranının GERÇEK kök nedeni). Electron 38 +
              // sandbox:false gerçek ESM preload'ı destekliyor - main'le AYNI
              // çözüm (format:'es') burada da uygulanıyor.
              rollupOptions: {
                output: {
                  format: 'es',
                  entryFileNames: '[name].mjs',
                },
              },
            },
          },
        },
      }),
    ],
    clearScreen: false,
  };
});
