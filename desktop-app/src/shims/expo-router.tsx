import React, { useEffect, useState } from 'react';

/**
 * expo-router'ın masaüstünde karşılığı yok (Metro'nun dosya-tabanlı route
 * üretimine dayanıyor, Vite'ta bu yok) — bu proje sadece 2 "modal" ekran
 * (pair-device, server-settings) kullandığından, tam bir router yerine
 * bu küçük, state-tabanlı geçiş kullanılıyor (en az sürtünmeli seçenek).
 * vite.config.ts'te 'expo-router' specifier'ı bu dosyaya alias'lanıyor,
 * reused ekranlardaki `import { router } from 'expo-router'` satırı
 * değişmeden çalışıyor.
 */
type OverlayPath = '/pair-device' | '/server-settings' | null;

let currentOverlay: OverlayPath = null;
const listeners = new Set<(path: OverlayPath) => void>();

function setOverlay(path: OverlayPath): void {
  currentOverlay = path;
  listeners.forEach((listener) => listener(path));
}

export const router = {
  push(path: string): void {
    setOverlay(path as OverlayPath);
  },
  replace(path: string): void {
    setOverlay(path === '/' ? null : (path as OverlayPath));
  },
  back(): void {
    setOverlay(null);
  },
  canGoBack(): boolean {
    return currentOverlay !== null;
  },
};

/** App.tsx bu hook ile hangi overlay ekranının açık olduğunu izler. */
export function useOverlayPath(): OverlayPath {
  const [path, setPath] = useState<OverlayPath>(currentOverlay);
  useEffect(() => {
    listeners.add(setPath);
    return () => {
      listeners.delete(setPath);
    };
  }, []);
  return path;
}
