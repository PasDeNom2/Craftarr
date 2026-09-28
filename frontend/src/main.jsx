import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { I18nProvider } from './i18n';
import ErrorBoundary from './components/ui/ErrorBoundary';
import './index.css';

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
          position="top-right"
          gutter={10}
          toastOptions={{
            style: {
              background: 'var(--glass-bg-strong)',
              backdropFilter: 'blur(40px) saturate(190%)',
              WebkitBackdropFilter: 'blur(40px) saturate(190%)',
              color: 'var(--fg)',
              boxShadow: 'var(--shadow-pop)',
              borderRadius: '18px',
              fontSize: '13px',
              padding: '10px 14px',
              maxWidth: '420px',
            },
            success: { iconTheme: { primary: 'var(--accent)', secondary: 'var(--surface)' } },
            error: { duration: 6000, iconTheme: { primary: 'var(--danger)', secondary: 'var(--surface)' } },
          }}
        />
      </QueryClientProvider>
    </ErrorBoundary>
  </I18nProvider>
);
