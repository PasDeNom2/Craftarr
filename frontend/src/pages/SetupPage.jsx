import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { setupAdmin } from '../services/api';
import { useAuthStore } from '../store';
import { useI18n } from '../i18n';
import AuthShell from '../components/layout/AuthShell';
import { ShieldCheck } from 'lucide-react';

export default function SetupPage() {
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const { setToken, setUser } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useI18n();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!setupToken || !username || !password || !confirm) return;
    if (password !== confirm) {
      toast.error(t('setup.passwordMismatch'));
      return;
    }
    if (password.length < 8) {
      toast.error(t('setup.errorShort'));
      return;
    }
    setLoading(true);
    try {
      const data = await setupAdmin(username, password, setupToken);
      setToken(data.token);
      setUser({ username: data.username });
      toast.success(t('setup.success'));
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || t('setup.errorAccount'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell subtitle={t('setup.subtitle')}>
      <div
        className="flex items-start gap-3 rounded-xl px-4 py-3 mb-4 text-[13px] leading-relaxed"
        style={{ background: 'rgba(var(--accent-rgb),0.07)', border: '1px solid rgba(var(--accent-rgb),0.2)' }}
      >
        <ShieldCheck size={16} strokeWidth={1.75} className="shrink-0 mt-0.5 text-accent" />
        <span className="text-fg-2">{t('setup.notice')}</span>
      </div>

      <form onSubmit={handleSubmit} className="card !p-6 space-y-4" style={{ boxShadow: 'var(--shadow-pop)' }}>
        <div>
          <label className="label" htmlFor="setup-token">{t('setup.token')}</label>
          <input
            id="setup-token" type="text" className="input h-11 font-pixel text-[13px] tracking-[0.2em] uppercase"
            value={setupToken} onChange={e => setSetupToken(e.target.value)}
            placeholder="XXXXXXXXXXXX" autoFocus autoComplete="off" spellCheck={false} required
          />
          <p className="text-[11px] text-fg-3 mt-1.5 font-mono">{t('setup.tokenHint')}</p>
        </div>

        <div className="border-t border-line" />

        <div>
          <label className="label" htmlFor="setup-username">{t('setup.username')}</label>
          <input
            id="setup-username" type="text" className="input h-11" value={username}
            onChange={e => setUsername(e.target.value)} placeholder="admin" minLength={3} autoComplete="username" required
          />
          <p className="text-[11px] text-fg-3 mt-1.5">{t('setup.usernameHint')}</p>
        </div>

        <div>
          <label className="label" htmlFor="setup-password">{t('setup.password')}</label>
          <input
            id="setup-password" type="password" className="input h-11" value={password}
            onChange={e => setPassword(e.target.value)} placeholder="••••••••" minLength={8} autoComplete="new-password" required
          />
          {/* Jauge de longueur : 8 blocs, façon barre d'expérience */}
          <div className="flex gap-1 mt-2" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <span key={i} className="h-1.5 flex-1 rounded-sm transition-colors"
                style={{ background: i < Math.min(password.length, 16) / 2 ? 'var(--accent)' : 'var(--surface-3)' }} />
            ))}
          </div>
          <p className="text-[11px] text-fg-3 mt-1.5">{t('setup.passwordHint')}</p>
        </div>

        <div>
          <label className="label" htmlFor="setup-confirm">{t('setup.confirm')}</label>
          <input
            id="setup-confirm" type="password" className="input h-11" value={confirm}
            onChange={e => setConfirm(e.target.value)} placeholder="••••••••" autoComplete="new-password" required
          />
          {confirm && password !== confirm && (
            <p className="text-[11px] text-danger mt-1.5">{t('setup.passwordMismatch')}</p>
          )}
        </div>

        <button
          type="submit"
          className="btn-primary w-full justify-center h-11 mt-2"
          disabled={loading || (confirm.length > 0 && password !== confirm)}
        >
          {loading ? t('setup.loading') : t('setup.submit')}
        </button>
      </form>
    </AuthShell>
  );
}
