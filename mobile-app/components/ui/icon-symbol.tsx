import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { OpaqueColorValue, type StyleProp, type TextStyle } from 'react-native';

/**
 * Sekme çubuğu ikonları.
 *
 * Bu dosya eskiden Expo şablonundan gelen SF Symbols -> Material Icons
 * eşlemesiydi (expo-symbols'e bağlı, iOS'ta SymbolView kullanan bir .ios.tsx
 * eşlikçisiyle). Proje yalnızca Android'i hedeflediğinden o katman kaldırıldı:
 * .ios.tsx dosyası, expo-symbols bağımlılığı ve hiç kullanılmayan dört eşleme
 * (house.fill, paperplane.fill, chevron.right, chevron.left...) silindi.
 */
const ICONS = {
  bell: 'notifications',
  folder: 'folder',
  upload: 'ios-share',
} as const;

export type IconSymbolName = keyof typeof ICONS;

export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
}) {
  return <MaterialIcons color={color} size={size} name={ICONS[name]} style={style} />;
}
