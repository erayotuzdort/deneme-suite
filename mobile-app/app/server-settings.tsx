import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/contexts/theme-context';
import { getApiBaseUrl, setApiBaseUrl } from '@/services/apiConfig';

function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const withoutTrailingSlash = withScheme.replace(/\/+$/, '');
  try {
    new URL(withoutTrailingSlash);
  } catch {
    return null;
  }
  return withoutTrailingSlash;
}

export default function ServerSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t } = useAppTheme();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * Kayıtlı adresi kutuya yükle. Eskiden kutu HER ZAMAN boş açılıyordu:
   * kullanıcı hangi adresi girdiğini göremiyor, doğrulayamıyor, tek bir
   * harfi düzeltmek için baştan yazmak zorunda kalıyordu.
   */
  useEffect(() => {
    let alive = true;
    getApiBaseUrl().then((saved) => {
      if (alive && saved) setAddress(saved);
    });
    return () => {
      alive = false;
    };
  }, []);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const hasInput = address.trim().length > 0;
  const canSave = hasInput && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    const normalized = normalizeBaseUrl(address);
    if (!normalized) {
      setSaving(false);
      setError('Geçersiz adres, tekrar kontrol et');
      return;
    }

    try {
      await setApiBaseUrl(normalized);
    } catch {
      setSaving(false);
      setError('Kaydetme başarısız oldu');
      return;
    }

    setSaving(false);
    close();
  };

  const btnBg = saving ? t.accentDeep : hasInput ? t.accent : t.btnIdle;
  const btnFg = hasInput || saving ? t.onAccent : t.btnIdleFg;
  const btnBorder = hasInput || saving ? 'transparent' : t.btnIdleBorder;

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Sunucu Adresi</Text>
          <Text style={[styles.subtitle, { color: t.accent }]}>Ev sunucusunun Tailscale adresini gir</Text>
        </View>
        <Pressable
          onPress={close}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
          style={[styles.closeBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Ionicons name="close" size={20} color={t.text} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <Text style={[styles.label, { color: t.muted }]}>SUNUCU ADRESİ</Text>
        <TextInput
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            setError(null);
          }}
          // Örnek adres, Tailscale'in CGNAT aralığından (100.64.0.0/10)
          // seçilmiş sahte bir değer - gerçek bir makineye ait değil.
          placeholder="100.64.0.1:4000"
          placeholderTextColor={t.dim}
          accessibilityLabel="Sunucu adresi"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[
            styles.addressInput,
            { borderColor: error ? t.helperWarn : t.border, backgroundColor: t.inputBg, color: t.text },
          ]}
        />
        <Text style={[styles.hintText, { color: t.muted }]}>
          http:// yazmazsan otomatik eklenir. Adres kaydedilirken bağlantı denenmez — Aktarım sekmesindeki SUNUCU
          kartından kontrol edebilirsin.
        </Text>

        {error ? (
          <View style={[styles.banner, { backgroundColor: t.rowBgSel, borderColor: t.helperWarn }]}>
            <Ionicons name="alert-circle-outline" size={16} color={t.helperWarn} />
            <Text style={[styles.bannerText, { color: t.helperWarn }]}>{error}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.footer}>
        <Pressable
          onPress={handleSave}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel={saving ? 'Kaydediliyor' : 'Kaydet'}
          accessibilityState={{ disabled: !canSave }}
          style={[styles.saveBtn, { backgroundColor: btnBg, borderColor: btnBorder }]}>
          <Ionicons name="checkmark" size={18} color={btnFg} />
          <Text style={[styles.saveLabel, { color: btnFg }]}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 22, gap: 8 },
  label: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5 },
  addressInput: {
    height: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 14,
    fontFamily: 'monospace',
  },
  hintText: { fontSize: 11, fontWeight: '500', lineHeight: 15 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  bannerText: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  footer: { paddingHorizontal: 14, paddingBottom: 18 },
  saveBtn: {
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  saveLabel: { fontSize: 15.5, fontWeight: '700', letterSpacing: -0.2 },
});
