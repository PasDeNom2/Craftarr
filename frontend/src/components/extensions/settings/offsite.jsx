import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  getOffsiteSettings,
  updateOffsiteSettings,
  testOffsiteRepository,
  initOffsiteRepository,
} from '../../../services/features/offsite';
import { useI18n } from '../../../i18n';

export const section = {
  id: 'offsite',
  titleKey: 'offsite.title',
  descKey: 'offsite.desc',
  order: 35,
};

function ConfiguredBadge({ label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-2 shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-success" />
      {label}
    </span>
  );
}

export default function OffsiteSettingsSection() {
  const { t } = useI18n();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['offsite-settings'],
    queryFn: getOffsiteSettings,
    staleTime: 30000,
  });

  const [repoDraft, setRepoDraft] = useState(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [envDraft, setEnvDraft] = useState('');
  const [clearEnv, setClearEnv] = useState(false);
  const [dailyDraft, setDailyDraft] = useState(null);
  const [weeklyDraft, setWeeklyDraft] = useState(null);
  const [monthlyDraft, setMonthlyDraft] = useState(null);

  const repository = repoDraft ?? data?.offsite_repository ?? '';
  const keepDaily = dailyDraft ?? String(data?.offsite_keep_daily ?? 7);
  const keepWeekly = weeklyDraft ?? String(data?.offsite_keep_weekly ?? 4);
  const keepMonthly = monthlyDraft ?? String(data?.offsite_keep_monthly ?? 6);

  const dirty =
    (repoDraft !== null && repoDraft !== (data?.offsite_repository ?? '')) ||
    passwordDraft.length > 0 ||
    clearPassword ||
    envDraft.trim().length > 0 ||
    clearEnv ||
    (dailyDraft !== null && dailyDraft !== String(data?.offsite_keep_daily ?? 7)) ||
    (weeklyDraft !== null && weeklyDraft !== String(data?.offsite_keep_weekly ?? 4)) ||
    (monthlyDraft !== null && monthlyDraft !== String(data?.offsite_keep_monthly ?? 6));

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        offsite_repository: repository.trim(),
        offsite_keep_daily: Number(keepDaily),
        offsite_keep_weekly: Number(keepWeekly),
        offsite_keep_monthly: Number(keepMonthly),
      };
      if (clearPassword) payload.offsite_password = null;
      else if (passwordDraft.length > 0) payload.offsite_password = passwordDraft;

      if (clearEnv) payload.offsite_env = null;
      else if (envDraft.trim().length > 0) payload.offsite_env = envDraft;

      return updateOffsiteSettings(payload);
    },
    onSuccess: () => {
      setRepoDraft(null);
      setPasswordDraft('');
      setClearPassword(false);
      setEnvDraft('');
      setClearEnv(false);
      setDailyDraft(null);
      setWeeklyDraft(null);
      setMonthlyDraft(null);
      qc.invalidateQueries({ queryKey: ['offsite-settings'] });
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      toast.success(t('offsite.saveSuccess'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const testMut = useMutation({
    mutationFn: testOffsiteRepository,
    onSuccess: () => toast.success(t('offsite.testSuccess')),
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const initMut = useMutation({
    mutationFn: initOffsiteRepository,
    onSuccess: (res) => {
      toast.success(res?.alreadyInitialized ? t('offsite.alreadyInitialized') : t('offsite.initSuccess'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const isBusy = saveMut.isPending || testMut.isPending || initMut.isPending;
  const canConnect = !dirty && !!data?.offsite_repository && !!data?.has_password;

  function handleSubmit(e) {
    e.preventDefault();
    if (!dirty || isBusy) return;
    saveMut.mutate();
  }

  return (
    <form className="card space-y-4" onSubmit={handleSubmit}>
      <div>
        <label htmlFor="offsite-repository" className="label">{t('offsite.repository')}</label>
        <input
          id="offsite-repository"
          className="input font-mono text-[12.5px]"
          value={repository}
          onChange={e => setRepoDraft(e.target.value)}
          placeholder={t('offsite.repositoryPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-[12px] text-fg-3 mt-1.5">{t('offsite.repositoryHint')}</p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <label htmlFor="offsite-password" className="label !mb-0">{t('offsite.password')}</label>
          <div className="flex items-center gap-2">
            {data?.has_password && !clearPassword && (
              <>
                <ConfiguredBadge label={t('offsite.configured')} />
                <button
                  type="button"
                  className="text-[11.5px] text-fg-3 hover:text-fg transition-colors"
                  onClick={() => { setClearPassword(true); setPasswordDraft(''); }}
                >
                  {t('offsite.clearSecret')}
                </button>
              </>
            )}
          </div>
        </div>
        <input
          id="offsite-password"
          type="password"
          className="input font-mono text-[12.5px]"
          value={passwordDraft}
          onChange={e => { setPasswordDraft(e.target.value); setClearPassword(false); }}
          placeholder={data?.has_password && !clearPassword ? '••••••••••••••••' : t('offsite.passwordPlaceholder')}
          autoComplete="new-password"
        />
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <label htmlFor="offsite-env" className="label !mb-0">{t('offsite.env')}</label>
          <div className="flex items-center gap-2">
            {data?.has_env && !clearEnv && (
              <>
                <ConfiguredBadge label={t('offsite.configured')} />
                <button
                  type="button"
                  className="text-[11.5px] text-fg-3 hover:text-fg transition-colors"
                  onClick={() => { setClearEnv(true); setEnvDraft(''); }}
                >
                  {t('offsite.clearSecret')}
                </button>
              </>
            )}
          </div>
        </div>
        <textarea
          id="offsite-env"
          rows={3}
          className="input font-mono text-[12px]"
          value={envDraft}
          onChange={e => { setEnvDraft(e.target.value); setClearEnv(false); }}
          placeholder={data?.has_env && !clearEnv ? '••••••••••••••••' : t('offsite.envPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-[12px] text-fg-3 mt-1.5">{t('offsite.envHint')}</p>
      </div>

      <div>
        <p className="label">{t('offsite.retention')}</p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="offsite-keep-daily" className="block text-[11.5px] text-fg-3 mb-1">
              {t('offsite.keepDaily')}
            </label>
            <input
              id="offsite-keep-daily"
              type="number"
              min={0}
              max={3650}
              className="input font-mono text-[13px]"
              value={keepDaily}
              onChange={e => setDailyDraft(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="offsite-keep-weekly" className="block text-[11.5px] text-fg-3 mb-1">
              {t('offsite.keepWeekly')}
            </label>
            <input
              id="offsite-keep-weekly"
              type="number"
              min={0}
              max={520}
              className="input font-mono text-[13px]"
              value={keepWeekly}
              onChange={e => setWeeklyDraft(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="offsite-keep-monthly" className="block text-[11.5px] text-fg-3 mb-1">
              {t('offsite.keepMonthly')}
            </label>
            <input
              id="offsite-keep-monthly"
              type="number"
              min={0}
              max={120}
              className="input font-mono text-[13px]"
              value={keepMonthly}
              onChange={e => setMonthlyDraft(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button
          type="button"
          className="btn-secondary"
          disabled={!canConnect || isBusy}
          onClick={() => testMut.mutate()}
        >
          {testMut.isPending ? t('offsite.testing') : t('offsite.test')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={!canConnect || isBusy}
          onClick={() => initMut.mutate()}
        >
          {initMut.isPending ? t('offsite.initializing') : t('offsite.init')}
        </button>
        <button type="submit" className="btn-primary" disabled={!dirty || isBusy}>
          {saveMut.isPending ? t('offsite.saving') : t('offsite.save')}
        </button>
      </div>
    </form>
  );
}
