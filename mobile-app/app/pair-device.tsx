import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDevices } from '@/contexts/device-context';
import { useAppTheme } from '@/contexts/theme-context';
import { consumePairingReason } from '@/services/auth-events';
import { InvalidCredentialsError, saveCredentials } from '@/services/credentials';

/** Yapıştırılan metnin makul üst sınırı — bkz. handleSave'deki not. */
const MAX_PASTE_LENGTH = 4000;

/**
 * Eskiden bu üç durumun üçü de "Geçersiz format, tekrar kontrol et" diyordu ve
 * kullanıcı neyin yanlış olduğunu anlayamıyordu. Artık her biri kendi mesajını
 * veriyor.
 */
type ParseResult =
  | { ok: true; deviceId: string; token: string }
  | { ok: false; error: string };

function extractDeviceIdAndToken(parsed: unknown): ParseResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Kod bir JSON nesnesi olmalı — sunucudaki satırın tamamını yapıştır' };
  }
  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof obj.deviceId !== 'string') missing.push('deviceId');
  if (typeof obj.token !== 'string') missing.push('token');
  if (missing.length > 0) {
    return { ok: false, error: `Kodda ${missing.join(' ve ')} alanı eksik` };
  }
  return { ok: true, deviceId: obj.deviceId as string, token: obj.token as string };
}

export default function PairDeviceScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t } = useAppTheme();
  const { refresh: refreshDevices, triggerBurstCheck } = useDevices();
  const [pastedText, setPastedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Ekran 401 yüzünden mi açıldı? Kullanıcı sebebi bilmeli. */
  const [reopenedByAuthFailure, setReopenedByAuthFailure] = useState(false);

  useEffect(() => {
    setReopenedByAuthFailure(consumePairingReason() === 'unauthorized');
  }, []);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const hasInput = pastedText.trim().length > 0;
  const canSave = hasInput && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    const trimmed = pastedText.trim();
    // Çok uzun bir metin yapıştırılırsa JSON.parse JS iş parçacığını kilitler;
    // eşleştirme kodu birkaç yüz karakter olduğundan bu sınır fazlasıyla geniş.
    if (trimmed.length > MAX_PASTE_LENGTH) {
      setSaving(false);
      setError('Yapıştırılan metin çok uzun — yalnızca eşleştirme satırını yapıştır');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      setSaving(false);
      setError('Geçerli bir JSON değil — kopyalarken bir karakter eksik kalmış olabilir');
      return;
    }

    const credentials = extractDeviceIdAndToken(parsed);
    if (!credentials.ok) {
      setSaving(false);
      setError(credentials.error);
      return;
    }

    try {
      await saveCredentials(credentials.deviceId, credentials.token);
    } catch (e) {
      setSaving(false);
      setError(e instanceof InvalidCredentialsError ? e.message : 'Kaydetme başarısız oldu');
      return;
    }

    setSaving(false);
    // 9a/9b: yeni eşleştirilen cihazın listede hemen görünmesi için anlık
    // yenileme + takip eden ~50sn boyunca burst kontrol.
    refreshDevices({ force: true });
    triggerBurstCheck();
    close();
  };

  const btnBg = saving ? t.accentDeep : hasInput ? t.accent : t.btnIdle;
  const btnFg = hasInput || saving ? t.onAccent : t.btnIdleFg;
  const btnBorder = hasInput || saving ? 'transparent' : t.btnIdleBorder;

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Cihazı Eşleştir</Text>
          <Text style={[styles.subtitle, { color: t.accent }]}>Sunucudan kopyaladığın kodu yapıştır</Text>
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
        {reopenedByAuthFailure ? (
          <View style={[styles.banner, { backgroundColor: t.rowBgSel, borderColor: t.helperWarn }]}>
            <Ionicons name="alert-circle-outline" size={16} color={t.helperWarn} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.bannerText, { color: t.helperWarn }]}>Kaydedilen eşleştirme geçersiz oldu</Text>
              <Text style={[styles.bannerHint, { color: t.muted }]}>
                Sunucu bu cihazı tanımadı. Sunucuda yeni bir kod üret ve onu yapıştır — aynı kod tekrar çalışmaz.
              </Text>
            </View>
          </View>
        ) : null}
        <Text style={[styles.label, { color: t.muted }]}>EŞLEŞTİRME KODU</Text>
        <TextInput
          value={pastedText}
          onChangeText={(v) => {
            setPastedText(v);
            setError(null);
          }}
          placeholder='{"deviceId":"...","token":"..."}'
          placeholderTextColor={t.dim}
          accessibilityLabel="Eşleştirme kodu"
          multiline
          maxLength={MAX_PASTE_LENGTH}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.pasteInput,
            { borderColor: error ? t.helperWarn : t.border, backgroundColor: t.inputBg, color: t.text },
          ]}
        />
        <Text style={[styles.hintText, { color: t.dim }]}>
          Sunucuda `npm run pair` çalıştır, çıkan satırı buraya yapıştır.
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
  pasteInput: {
    minHeight: 140,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 12.5,
    fontFamily: 'monospace',
    lineHeight: 18,
    textAlignVertical: 'top',
  },
  hintText: { fontSize: 11, fontWeight: '500', lineHeight: 15 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  bannerText: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  bannerHint: { fontSize: 11, fontWeight: '500', marginTop: 2 },
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
