import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { login } from '../services/api';
import { useAuthStore } from '../store';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/ui/LanguageSwitcher';
import { LogoMark } from '../components/ui/Logo';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { setToken, setUser } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useI18n();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    try {
      const data = await login(username, password);
      setToken(data.token);
      setUser({ username: data.username });
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || t('login.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      {/* Language switcher top-right */}
      <div className="fixed top-4 right-4">
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <LogoMark size={40} className="mx-auto mb-5" />
          <h1 className="text-[20px] font-semibold text-fg tracking-tight">Craftarr</h1>
          <p className="text-fg-2 text-sm mt-1">{t('app.tagline')}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="card space-y-4 !p-6"
        >
          <div>
            <label className="label">{t('login.username')}</label>
            <input
              type="text"
              className="input"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div>
            <label className="label">{t('login.password')}</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            className="btn-primary w-full mt-2"
            disabled={loading}
          >
            {loading ? t('login.loading') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
