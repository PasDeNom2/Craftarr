import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { I18nProvider } from './i18n';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000 },
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <I18nProvider>
  <QueryClientProvider client={queryClient}>
    <App />
    <Toaster
      position="top-right"
      toastOptions={{
        style: {
          background: '#131316',
          color: '#F0F0F0',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '10px',
          fontSize: '13px',
          padding: '10px 14px',
        },
        success: { iconTheme: { primary: '#4ADE80', secondary: '#131316' } },
        error:   { iconTheme: { primary: '#F87171', secondary: '#131316' } },
      }}
    />
  </QueryClientProvider>
  </I18nProvider>
);
