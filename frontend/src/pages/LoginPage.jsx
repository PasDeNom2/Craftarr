import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { login } from '../services/api';
import { useAuthStore } from '../store';
import { useI18n } from '../i18n';
import AuthShell from '../components/layout/AuthShell';
import { ArrowRight } from 'lucide-react';

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
    <AuthShell>
      <form onSubmit={handleSubmit} className="card !p-6 space-y-4" style={{ boxShadow: 'var(--shadow-pop)' }}>
        <div>
          <label className="label" htmlFor="login-username">{t('login.username')}</label>
          <input id="login-username" type="text" className="input h-11" value={username}
            onChange={e => setUsername(e.target.value)} placeholder="admin" autoFocus autoComplete="username" />
        </div>
        <div>
          <label className="label" htmlFor="login-password">{t('login.password')}</label>
          <input id="login-password" type="password" className="input h-11" value={password}
            onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
        </div>
        <button type="submit" className="btn-primary w-full justify-center h-11 mt-2" disabled={loading || !username || !password}>
          {loading ? t('login.loading') : t('login.submit')}
          {!loading && <ArrowRight size={15} strokeWidth={2.25} />}
        </button>
      </form>
    </AuthShell>
  );
}
