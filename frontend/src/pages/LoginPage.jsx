import React, { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { login } from '../services/api';
import { verifyTwoFactor } from '../services/features/accounts';
import { useAuthStore } from '../store';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/ui/LanguageSwitcher';
import { LogoMark } from '../components/ui/Logo';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const { setToken, setUser } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useI18n();
  const id = useId();

  async function handleSubmit(e) {
    e.preventDefault();
    if (challenge) {
      const trimmed = code.trim();
      if (!trimmed) return;
      setLoading(true);
      try {
        const data = await verifyTwoFactor(
          challenge,
          useRecovery ? { recoveryCode: trimmed } : { code: trimmed }
        );
        setToken(data.token);
        setUser({ username: data.username, role: data.role });
        navigate('/', { replace: true });
      } catch (err) {
        toast.error(err.response?.data?.error || t('accounts.login.error'));
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!username || !password) return;
    setLoading(true);
    try {
      const data = await login(username, password);
      if (data.twoFactorRequired && data.challenge) {
        setChallenge(data.challenge);
        setCode('');
        setUseRecovery(false);
        return;
      }
      setToken(data.token);
      setUser({ username: data.username, role: data.role });
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
          {challenge ? (
            <>
              <div>
                <h2 className="text-[15px] font-semibold text-fg">{t('accounts.login.twoFactorTitle')}</h2>
                <p className="text-[12.5px] text-fg-2 mt-1">
                  {useRecovery ? t('accounts.login.recoveryHint') : t('accounts.login.twoFactorHint')}
                </p>
              </div>
              <div>
                <label htmlFor={`${id}-2fa`} className="label">
                  {useRecovery ? t('accounts.login.recoveryLabel') : t('accounts.login.codeLabel')}
                </label>
                {useRecovery ? (
                  <input
                    id={`${id}-2fa`}
                    type="text"
                    className="input font-mono text-center tracking-wider"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder="XXXX-XXXX"
                    autoComplete="off"
                    autoFocus
                  />
                ) : (
                  <input
                    id={`${id}-2fa`}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    pattern="[0-9]*"
                    className="input font-mono text-center tracking-widest"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder="123456"
                    autoFocus
                  />
                )}
              </div>
              <button
                type="submit"
                className="btn-primary w-full mt-2"
                disabled={loading}
              >
                {loading ? t('login.loading') : t('accounts.login.verify')}
              </button>
              <div className="flex items-center justify-between text-[12.5px] pt-1">
                <button
                  type="button"
                  className="text-fg-2 hover:text-fg underline underline-offset-2"
                  onClick={() => { setUseRecovery(r => !r); setCode(''); }}
                >
                  {useRecovery ? t('accounts.login.useTotp') : t('accounts.login.useRecovery')}
                </button>
                <button
                  type="button"
                  className="text-fg-3 hover:text-fg"
                  onClick={() => { setChallenge(null); setCode(''); setUseRecovery(false); }}
                >
                  {t('accounts.login.backToLogin')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor={`${id}-username`} className="label">{t('login.username')}</label>
                <input
                  id={`${id}-username`}
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
                <label htmlFor={`${id}-password`} className="label">{t('login.password')}</label>
                <input
                  id={`${id}-password`}
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
            </>
          )}
        </form>
      </div>
    </div>
  );
}
