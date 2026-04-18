import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuthStore } from './store';
import { getMe, checkSetupNeeded } from './services/api';
import Layout from './components/layout/Layout';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import CatalogPage from './pages/CatalogPage';
import ServerDetailPage from './pages/ServerDetailPage';
import SettingsPage from './pages/SettingsPage';

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
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="w-5 h-5 border border-[#4A4A55] border-t-transparent rounded-full animate-spin"
          style={{ borderTopColor: 'transparent' }} />
      </div>
    );
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
  }, [token]);

  return (
    <BrowserRouter>
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
          <Route index element={<CatalogPage />} />
          <Route path="catalog" element={<CatalogPage />} />
          <Route path="servers/:id" element={<ServerDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
