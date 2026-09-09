import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

type Props = { children: React.ReactNode; screenLabel: string };
type State = { error: Error | null };

/**
 * Beklenmedik bir render hatasında (ör. window.desktop enjekte edilmemişse -
 * preload script yüklenemedi, paketleme hatası vb.) sessiz bir siyah ekran
 * yerine anlaşılır bir hata mesajı gösterir. `screenLabel`, hangi sekmenin
 * başarısız olduğunu belirtmek için App.tsx'ten geçiliyor - teknik detay/
 * stack trace göstermeden ("Bir şeyler ters gitti" yerine "Sunucu sekmesi
 * yüklenemedi" gibi).
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`deneme-desktop render hatası (${this.props.screenLabel}):`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.screen}>
          <Text style={styles.title}>{this.props.screenLabel} yüklenemedi</Text>
          <Text style={styles.message}>
            Beklenmedik bir hata oluştu. Sol menüden başka bir sekmeye geçip tekrar dene.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0b0c', gap: 8, padding: 24 },
  title: { color: '#f2f3f5', fontSize: 18, fontWeight: '800' },
  message: { color: '#8b8d97', fontSize: 13, textAlign: 'center' },
});
