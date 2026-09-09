import React from 'react';
import * as Io5 from 'react-icons/io5';

/**
 * @expo/vector-icons/Ionicons'un masaüstü (react-icons/io5, saf SVG)
 * karşılığı — vite.config.ts'te bu dosya '@expo/vector-icons/Ionicons'
 * specifier'ına ALIAS'lanıyor, yani reused ekranlardaki
 * `import Ionicons from '@expo/vector-icons/Ionicons'` satırı HİÇ
 * değişmeden buraya bağlanıyor.
 *
 * react-native-vector-icons/expo'nun webde kullandığı icon-font (@font-face)
 * yaklaşımı yerine react-icons'un SVG bileşenleri tercih edildi — font
 * yükleme/FOUC riski yok, Vite'ta ekstra asset/CSS yapılandırması gerekmiyor.
 * Ionicons'un kebab-case adları ("arrow-down") react-icons/io5'te deterministik
 * olarak PascalCase + "Io" öneki ile karşılık buluyor ("IoArrowDown") - bu
 * dönüşüm, projede fiilen kullanılan TÜM ikon adları için (bkz. commit mesajı)
 * elle doğrulandı.
 */
function toIo5ComponentName(name: string): string {
  const pascal = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `Io${pascal}`;
}

export type IoniconsProps = {
  name: string;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
};

export default function Ionicons({ name, size = 24, color, style }: IoniconsProps) {
  const componentName = toIo5ComponentName(name);
  const IconComponent = (Io5 as unknown as Record<string, React.ComponentType<{ size?: number; color?: string }>>)[
    componentName
  ];

  if (!IconComponent) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`Ionicons shim: "${name}" (${componentName}) react-icons/io5'te bulunamadı`);
    }
    return <span style={{ width: size, height: size, display: 'inline-block', ...style }} />;
  }

  return (
    <span style={{ display: 'inline-flex', lineHeight: 0, ...style }}>
      <IconComponent size={size} color={color} />
    </span>
  );
}
