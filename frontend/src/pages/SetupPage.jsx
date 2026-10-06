import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { setupAdmin } from '../services/api';
import { useAuthStore } from '../store';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/ui/LanguageSwitcher';
import { ShieldCheck } from 'lucide-react';
import { LogoMark } from '../components/ui/Logo';

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
    <div className="min-h-screen flex items-center justify-center p-4">
      {/* Language switcher top-right */}
      <div className="fixed top-4 right-4">
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <LogoMark size={40} className="mx-auto mb-5" />
          <h1 className="text-[20px] font-semibold text-fg tracking-tight">Craftarr</h1>
          <p className="text-fg-2 text-sm mt-1">{t('setup.subtitle')}</p>
        </div>

        <div
          className="flex items-start gap-3 rounded-xl px-4 py-3 mb-5 text-sm"
          style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
        >
          <ShieldCheck size={15} strokeWidth={1.5} className="shrink-0 mt-0.5 text-fg-2" />
          <span className="text-fg-2">{t('setup.notice')}</span>
        </div>

        <form
          onSubmit={handleSubmit}
          className="card space-y-4 !p-6"
        >
          <div>
            <label className="label">{t('setup.token')}</label>
            <input
              type="text"
              className="input font-mono uppercase tracking-widest"
              value={setupToken}
              onChange={e => setSetupToken(e.target.value)}
              placeholder="XXXXXXXXXXXX"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              required
            />
            <p className="text-[11px] text-fg-3 mt-1">{t('setup.tokenHint')}</p>
          </div>

          <div>
            <label className="label">{t('setup.username')}</label>
            <input
              type="text"
              className="input"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="admin"
              minLength={3}
              autoComplete="username"
              required
            />
            <p className="text-[11px] text-fg-3 mt-1">{t('setup.usernameHint')}</p>
          </div>

          <div>
            <label className="label">{t('setup.password')}</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              minLength={8}
              autoComplete="new-password"
              required
            />
            <p className="text-[11px] text-fg-3 mt-1">{t('setup.passwordHint')}</p>
          </div>

          <div>
            <label className="label">{t('setup.confirm')}</label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              required
            />
            {confirm && password !== confirm && (
              <p className="text-[11px] text-danger mt-1">{t('setup.passwordMismatch')}</p>
            )}
          </div>

          <button
            type="submit"
            className="btn-primary w-full mt-2"
            disabled={loading || (confirm.length > 0 && password !== confirm)}
          >
            {loading ? t('setup.loading') : t('setup.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
