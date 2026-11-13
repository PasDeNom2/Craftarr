import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { I18nProvider } from './i18n';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { useThemeStore } from './store';
// Polices auto-hébergées : latin, latin étendu et cyrillique (langues de l'interface)
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-ext-400.css';
import '@fontsource/geist/cyrillic-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-ext-500.css';
import '@fontsource/geist/cyrillic-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist/latin-ext-600.css';
import '@fontsource/geist/cyrillic-600.css';
import '@fontsource/geist/latin-700.css';
import '@fontsource/geist/latin-ext-700.css';
import '@fontsource/geist/cyrillic-700.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-ext-400.css';
import '@fontsource/geist-mono/cyrillic-400.css';
import '@fontsource/geist-mono/latin-500.css';
import '@fontsource/geist-mono/latin-ext-500.css';
import '@fontsource/geist-mono/cyrillic-500.css';
import './index.css';

// Applique le thème enregistré et suit le mode « système » dès le démarrage
useThemeStore.getState();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <I18nProvider>
    {/* Dernier filet de sécurité : jamais d'écran blanc */}
    <ErrorBoundary scope="app">
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster
          position="bottom-right"
          gutter={10}
          toastOptions={{
            style: {
              background: 'var(--surface-3)',
              color: 'var(--fg)',
              boxShadow: 'var(--shadow-pop)',
              borderRadius: '10px',
              fontSize: '13px',
              padding: '10px 14px',
              maxWidth: '420px',
            },
            success: { iconTheme: { primary: 'var(--success)', secondary: 'var(--surface)' } },
            error: { duration: 6000, iconTheme: { primary: 'var(--danger)', secondary: 'var(--surface)' } },
          }}
        />
      </QueryClientProvider>
    </ErrorBoundary>
  </I18nProvider>
);
