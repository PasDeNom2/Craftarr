import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, RefreshCw, Terminal } from 'lucide-react';
import toast from 'react-hot-toast';
import { useI18n } from '../../../i18n';
import Switch from '../../ui/Switch';
import {
  getRouterSettings,
  updateRouterSettings,
  getRouterStatus,
} from '../../../services/features/router';

export const section = {
  id: 'router',
  titleKey: 'router.sectionTitle',
  descKey: 'router.sectionDesc',
  order: 25,
};

const COMPOSE_CMD = 'docker compose --profile router up -d';

export default function RouterSettingsSection() {
  const { t } = useI18n();
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['router-settings'],
    queryFn: getRouterSettings,
    staleTime: 30000,
  });

  const { data: status, isFetching: statusFetching, refetch: refetchStatus } = useQuery({
    queryKey: ['router-status'],
    queryFn: getRouterStatus,
    refetchInterval: 15000,
  });

  const [enabled, setEnabled] = useState(false);
  const [domain, setDomain] = useState('');

  useEffect(() => {
    if (!settings) return;
    setEnabled(!!settings.enabled);
    setDomain(settings.domain || '');
  }, [settings]);

  const dirty = settings
    ? enabled !== !!settings.enabled || domain.trim().toLowerCase() !== (settings.domain || '')
    : false;

  const saveMut = useMutation({
    mutationFn: () => updateRouterSettings({ enabled, domain: domain.trim().toLowerCase() }),
    onSuccess: (updated) => {
      setEnabled(!!updated.enabled);
      setDomain(updated.domain || '');
      qc.setQueryData(['router-settings'], updated);
      qc.invalidateQueries({ queryKey: ['servers'] });
      qc.invalidateQueries({ queryKey: ['server'] });
      toast.success(t('router.saved'));
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || t('router.saveError'));
    },
  });

  async function copyCompose() {
    const cmd = settings?.composeCommand || COMPOSE_CMD;
    try {
      await navigator.clipboard.writeText(cmd);
      toast.success(t('router.commandCopied'));
    } catch {
      toast(cmd);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (enabled && !domain.trim()) {
      toast.error(t('router.domainRequired'));
      return;
    }
    saveMut.mutate();
  }

  const wildcard = `*.${domain.trim().toLowerCase() || 'mc.exemple.fr'}`;

  return (
    <div className="space-y-3">
      <div className="card flex items-center justify-between gap-4 !py-3.5">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-fg">{t('router.statusLabel')}</p>
          <p className="text-[12px] text-fg-2 mt-0.5 flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: status?.running ? 'var(--success)' : 'var(--fg-3)' }}
            />
            <span>{status?.running ? t('router.statusRunning') : t('router.statusStopped')}</span>
            {status?.containerId && (
              <span className="font-mono text-[11px] text-fg-3">({status.containerId})</span>
            )}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary !h-8 !px-2.5 shrink-0"
          onClick={() => refetchStatus()}
          disabled={statusFetching}
          aria-label={t('router.refreshStatus')}
          title={t('router.refreshStatus')}
        >
          <RefreshCw size={13} className={statusFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      <form className="card space-y-4" onSubmit={handleSubmit}>
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <span>
            <span className="block text-[13.5px] font-medium text-fg">{t('router.enable')}</span>
            <span className="block text-[12.5px] text-fg-2 mt-0.5">{t('router.enableHint')}</span>
          </span>
          <Switch
            checked={enabled}
            onChange={setEnabled}
            label={t('router.enable')}
          />
        </label>

        <div>
          <label htmlFor="router-domain-input" className="label">{t('router.domainLabel')}</label>
          <input
            id="router-domain-input"
            className="input font-mono text-[13px]"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            placeholder={t('router.domainPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-[12px] text-fg-3 mt-1.5">
            {t('router.domainHint', { wildcard })}
          </p>
        </div>

        <div className="rounded-lg border border-line bg-bg p-3 space-y-2">
          <p className="text-[12px] text-fg-2 flex items-center gap-1.5">
            <Terminal size={13} className="text-fg-3 shrink-0" />
            <span>{t('router.composeHint')}</span>
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[12px] text-fg truncate">
              {settings?.composeCommand || COMPOSE_CMD}
            </code>
            <button
              type="button"
              className="btn-secondary !h-7 !px-2.5 text-[12px] shrink-0"
              onClick={copyCompose}
              aria-label={t('router.copyCommand')}
            >
              <Copy size={12} />
            </button>
          </div>
          <p className="text-[11.5px] text-fg-3">{t('router.recreateNotice')}</p>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="btn-primary"
            disabled={!dirty || saveMut.isPending}
          >
            {saveMut.isPending ? t('router.saving') : t('router.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
