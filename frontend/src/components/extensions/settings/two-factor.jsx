import React, { useEffect, useId, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import toast from 'react-hot-toast';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import {
  getTwoFactorStatus,
  setupTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
} from '../../../services/features/accounts';
import { getMe } from '../../../services/api';
import { useAuthStore } from '../../../store';
import { useI18n } from '../../../i18n';

export const section = {
  id: 'two-factor',
  titleKey: 'accounts.twoFactor.title',
  descKey: 'accounts.twoFactor.desc',
  order: 15,
};

export default function TwoFactorSettingsSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setUser = useAuthStore(s => s.setUser);
  const id = useId();

  const { data: status } = useQuery({
    queryKey: ['2fa-status'],
    queryFn: getTwoFactorStatus,
    staleTime: 30000,
  });

  const [setupData, setSetupData] = useState(null);
  const [qrUrl, setQrUrl] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  useEffect(() => {
    let active = true;
    if (!setupData?.otpauthUrl) {
      setQrUrl('');
      return () => { active = false; };
    }
    QRCode.toDataURL(setupData.otpauthUrl, { width: 192, margin: 1 })
      .then(url => { if (active) setQrUrl(url); })
      .catch(() => { if (active) setQrUrl(''); });
    return () => { active = false; };
  }, [setupData?.otpauthUrl]);

  const setupMut = useMutation({
    mutationFn: setupTwoFactor,
    onSuccess: (data) => {
      setSetupData(data);
      setConfirmCode('');
      setRecoveryCodes(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const enableMut = useMutation({
    mutationFn: () => enableTwoFactor(confirmCode.trim()),
    onSuccess: (data) => {
      setSetupData(null);
      setConfirmCode('');
      setRecoveryCodes(data.recoveryCodes || []);
      qc.invalidateQueries({ queryKey: ['2fa-status'] });
      getMe().then(setUser).catch(() => {});
      toast.success(t('accounts.twoFactor.enabledToast'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('accounts.login.error')),
  });

  const disableMut = useMutation({
    mutationFn: () => disableTwoFactor(disablePassword, disableCode.trim()),
    onSuccess: () => {
      setDisablePassword('');
      setDisableCode('');
      setRecoveryCodes(null);
      qc.invalidateQueries({ queryKey: ['2fa-status'] });
      getMe().then(setUser).catch(() => {});
      toast.success(t('accounts.twoFactor.disabledToast'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const enabled = !!status?.enabled;

  async function copyText(text, markSecret = false) {
    try {
      await navigator.clipboard.writeText(text);
      if (markSecret) {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 1800);
      }
      toast.success(t('accounts.twoFactor.copied'));
    } catch {}
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className={enabled ? 'badge bg-success/15 text-success' : 'badge text-fg-3'}>
          <ShieldCheck size={13} className="mr-1" />
          {enabled ? t('accounts.twoFactor.enabledBadge') : t('accounts.twoFactor.disabledBadge')}
        </span>

        {!enabled && !setupData && !recoveryCodes && (
          <button
            type="button"
            className="btn-primary"
            disabled={setupMut.isPending}
            onClick={() => setupMut.mutate()}
          >
            {t('accounts.twoFactor.setupButton')}
          </button>
        )}
      </div>

      {/* Affichage unique des codes de secours après activation */}
      {recoveryCodes && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-fg">{t('accounts.twoFactor.recoveryTitle')}</p>
            <p className="text-[12.5px] text-fg-2 mt-0.5">{t('accounts.twoFactor.recoveryWarn')}</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[13px]">
            {recoveryCodes.map(c => (
              <div key={c} className="px-2.5 py-1.5 rounded bg-surface-2 border border-line text-center text-fg">
                {c}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => copyText(recoveryCodes.join('\n'))}
            >
              <Copy size={14} /> {t('accounts.twoFactor.copyRecovery')}
            </button>
            <button
              type="button"
              className="btn-primary ml-auto"
              onClick={() => setRecoveryCodes(null)}
            >
              {t('accounts.twoFactor.recoveryDone')}
            </button>
          </div>
        </div>
      )}

      {/* Assistant d'activation (QR + secret + code de confirmation) */}
      {!enabled && setupData && (
        <form
          onSubmit={e => { e.preventDefault(); enableMut.mutate(); }}
          className="rounded-lg border border-line p-4 space-y-4"
        >
          <p className="text-[13px] text-fg-2">{t('accounts.twoFactor.scanQr')}</p>
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
            {qrUrl && (
              <img
                src={qrUrl}
                alt="QR Code 2FA"
                width={160}
                height={160}
                className="rounded-lg bg-white p-2 border border-line shrink-0"
              />
            )}
            <div className="space-y-2 min-w-0 flex-1 w-full">
              <span className="label">{t('accounts.twoFactor.secretLabel')}</span>
              <div className="flex items-center gap-2">
                <code className="input font-mono text-[13px] select-all overflow-x-auto">
                  {setupData.secret}
                </code>
                <button
                  type="button"
                  className="btn-secondary shrink-0"
                  onClick={() => copyText(setupData.secret, true)}
                  aria-label={t('accounts.twoFactor.copySecret')}
                  title={t('accounts.twoFactor.copySecret')}
                >
                  {copiedSecret ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          </div>

          <div className="max-w-xs">
            <label htmlFor={`${id}-confirm`} className="label">{t('accounts.twoFactor.confirmLabel')}</label>
            <input
              id={`${id}-confirm`}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="input font-mono tracking-widest"
              value={confirmCode}
              onChange={e => setConfirmCode(e.target.value)}
              placeholder="123456"
              required
            />
          </div>

          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={enableMut.isPending || !confirmCode.trim()}>
              {t('accounts.twoFactor.enableButton')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setSetupData(null)}>
              {t('accounts.twoFactor.cancelSetup')}
            </button>
          </div>
        </form>
      )}

      {/* Formulaire de désactivation */}
      {enabled && (
        <form
          onSubmit={e => { e.preventDefault(); disableMut.mutate(); }}
          className="rounded-lg border border-line p-4 space-y-3"
        >
          <p className="text-[13px] text-fg-2">{t('accounts.twoFactor.disableHint')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-dis-pwd`} className="label">{t('accounts.twoFactor.currentPassword')}</label>
              <input
                id={`${id}-dis-pwd`}
                type="password"
                className="input"
                value={disablePassword}
                onChange={e => setDisablePassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div>
              <label htmlFor={`${id}-dis-code`} className="label">{t('accounts.twoFactor.verificationCode')}</label>
              <input
                id={`${id}-dis-code`}
                type="text"
                className="input font-mono"
                value={disableCode}
                onChange={e => setDisableCode(e.target.value)}
                placeholder="123456"
                required
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn-danger"
            disabled={disableMut.isPending || !disablePassword || !disableCode.trim()}
          >
            {t('accounts.twoFactor.disableButton')}
          </button>
        </form>
      )}
    </div>
  );
}
