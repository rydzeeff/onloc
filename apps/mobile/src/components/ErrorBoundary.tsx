import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export class ErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean; message: string }> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error) {
    console.error('[mobile-error-boundary]', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Что-то пошло не так</Text>
          <Text style={styles.subtitle}>Приложение столкнулось с ошибкой. Перезапустите экран.</Text>
          <Text style={styles.message}>{this.state.message}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#4b5563', marginBottom: 10 },
  message: { color: '#b91c1c' },
});
