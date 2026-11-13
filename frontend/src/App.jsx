import React, { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store';
import { getMe, checkSetupNeeded } from './services/api';
import Layout from './components/layout/Layout';
import LoginPage from './pages/LoginPage';

const SetupPage = lazy(() => import('./pages/SetupPage'));
const CatalogPage = lazy(() => import('./pages/CatalogPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ServerDetailPage = lazy(() => import('./pages/ServerDetailPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function SpinnerFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center atmosphere">
      <div className="w-5 h-5 border-2 border-line-strong border-t-fg rounded-full animate-spin" />
    </div>
  );
}

function PrivateRoute({ children }) {
  const token = useAuthStore(s => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

// Garde qui vérifie si le setup est requis avant de montrer le login
function AuthGate({ children }) {
  const [checking, setChecking] = useState(true);
  const [setupNeeded, setSetupNeeded] = useState(false);

  useEffect(() => {
    checkSetupNeeded()
      .then(({ needed }) => setSetupNeeded(needed))
      .catch(() => {}) // si l'API est down, on laisse passer
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <SpinnerFallback />;
  }

  if (setupNeeded) return <Navigate to="/setup" replace />;
  return children;
}

export default function App() {
  const { token, setUser } = useAuthStore();

  useEffect(() => {
    if (token) {
      getMe().then(setUser).catch(() => {});
    }
  }, [token, setUser]);

  return (
    <BrowserRouter>
      <Suspense fallback={<SpinnerFallback />}>
        <Routes>
          {/* Setup — premier démarrage, aucun compte existant */}
          <Route path="/setup" element={<SetupPage />} />

          {/* Login — avec vérification setup */}
          <Route path="/login" element={
            <AuthGate>
              <LoginPage />
            </AuthGate>
          } />

          {/* App principale */}
          <Route path="/" element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }>
            <Route index element={<DashboardPage />} />
            <Route path="catalog" element={<CatalogPage />} />
            <Route path="servers/:id" element={<ServerDetailPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
