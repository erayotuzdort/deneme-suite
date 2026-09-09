import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { AppTheme, getAppTheme } from '@/constants/app-theme';
import { readJson, writeJson } from '@/services/localStore';

type ThemeModeContextValue = {
  dark: boolean;
  toggleTheme: () => void;
  theme: AppTheme;
};

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

const THEME_KEY = 'themeMode:v1';
type StoredTheme = 'dark' | 'light' | null;

/**
 * Tema tercihi artık KALICI. Eskiden yalnızca useState'te tutuluyordu:
 * kullanıcı açık temaya geçiyor, uygulamayı kapatıp açınca koyu temaya
 * dönüyordu.
 *
 * Kullanıcı henüz bir tercih yapmadıysa sistem temasını izliyoruz. Eskiden
 * sistem değeri SADECE ilk render'da okunuyordu (`useState(systemScheme !== 'light')`);
 * useColorScheme() ilk karede null dönerse açık temalı bir telefonda bile
 * uygulama koyu açılabiliyordu ve sistem teması sonradan değişse de tepki
 * vermiyordu.
 */
export function ThemeModeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [stored, setStored] = useState<StoredTheme>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    readJson<StoredTheme>(THEME_KEY, null).then((v) => {
      if (!alive) return;
      if (v === 'dark' || v === 'light') setStored(v);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Tercih yoksa sistemi izle; systemScheme null iken koyuya düşmek yerine
  // yalnızca 'light' değilse koyu diyoruz ama artık her render'da tazeleniyor.
  const dark = stored ? stored === 'dark' : systemScheme !== 'light';

  const value = useMemo<ThemeModeContextValue>(
    () => ({
      dark,
      toggleTheme: () => {
        const next: StoredTheme = dark ? 'light' : 'dark';
        setStored(next);
        writeJson(THEME_KEY, next);
      },
      theme: getAppTheme(dark),
    }),
    [dark]
  );

  // loaded yalnızca ilk okumanın bittiğini bildirir; tema her hâlükârda
  // render edilebilir olduğundan ekranı bloklamıyoruz.
  void loaded;

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useAppTheme() {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useAppTheme must be used within a ThemeModeProvider');
  return ctx;
}
