import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Moon, PowerOff, Pause } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useI18n } from '../../../i18n';
import { useServerStore } from '../../../store';
import {
  getRouterSettings,
  patchServerSleep,
  recreateServerContainer,
} from '../../../services/features/router';

export const block = {
  id: 'sleep',
  order: 20,
};

function slugify(name) {
  const s = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return s || 'server';
}

export default function SleepServerBlock({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const patchStore = useServerStore(s => s.updateServer);

  const { data: routerSettings } = useQuery({
    queryKey: ['router-settings'],
    queryFn: getRouterSettings,
    staleTime: 30000,
  });

  const routerActive = !!(routerSettings?.enabled && routerSettings?.domain);

  const [mode, setMode] = useState(server.sleep_mode || 'off');
  const [minutes, setMinutes] = useState(server.sleep_after_minutes || 10);
  const [hostname, setHostname] = useState(server.hostname || '');
  const [recreating, setRecreating] = useState(false);

  const baseMode = server.sleep_mode || 'off';
  const baseMinutes = server.sleep_after_minutes || 10;
  const baseHostname = server.hostname || '';

  useEffect(() => {
    setMode(server.sleep_mode || 'off');
    setMinutes(server.sleep_after_minutes || 10);
    setHostname(server.hostname || '');
  }, [server.id, server.sleep_mode, server.sleep_after_minutes, server.hostname]);

  const cleanHostname = hostname.trim().toLowerCase();
  const dirty =
    mode !== baseMode ||
    Number(minutes) !== Number(baseMinutes) ||
    cleanHostname !== baseHostname;

  const isStopped = server.status === 'stopped' || server.status === 'error';
  const isRunning = server.status === 'running' || server.status === 'starting';

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        sleep_mode: mode,
        sleep_after_minutes: Math.max(1, Math.min(120, Math.round(Number(minutes) || 10))),
      };
      if (cleanHostname !== baseHostname) {
        payload.hostname = cleanHostname || null;
      }
      return patchServerSleep(server.id, payload);
    },
    onSuccess: async (updated) => {
      patchStore(server.id, updated);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      if (updated.needs_recreate && isStopped && updated.container_id) {
        setRecreating(true);
        try {
          await recreateServerContainer(server.id);
          patchStore(server.id, { status: 'starting', needs_recreate: false });
          qc.invalidateQueries({ queryKey: ['server', server.id] });
          toast.success(t('sleep.savedRecreated'));
        } catch (err) {
          toast.error((err.response?.data?.error || err.message || t('sleep.saveError')));
        } finally {
          setRecreating(false);
        }
      } else if (updated.needs_recreate && isRunning) {
        toast.success(t('sleep.savedNeedRecreate'));
      } else {
        toast.success(t('sleep.saved'));
      }
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || t('sleep.saveError'));
    },
  });

  const modes = [
    { id: 'off', label: t('sleep.modeOff'), desc: t('sleep.descOff'), Icon: PowerOff, disabled: false },
    { id: 'pause', label: t('sleep.modePause'), desc: t('sleep.descPause'), Icon: Pause, disabled: false },
    { id: 'stop', label: t('sleep.modeStop'), desc: t('sleep.descStop'), Icon: Moon, disabled: !routerActive },
  ];

  const activeDesc = modes.find(m => m.id === mode)?.desc || '';
  const defaultSlug = slugify(server.name);
  const previewSub = cleanHostname || defaultSlug;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[13px] font-semibold text-fg">{t('sleep.title')}</h3>
        {dirty && (
          <button
            type="button"
            className="btn-primary !h-7 !px-3 text-[12px]"
            disabled={saveMut.isPending || recreating}
            onClick={() => saveMut.mutate()}
          >
            <Save size={12} strokeWidth={2} />
            {saveMut.isPending || recreating ? t('sleep.saving') : t('sleep.save')}
          </button>
        )}
      </div>

      <div className="card !p-0 overflow-hidden divide-y divide-line">
        {server.pregen_enabled && (
          <div className="px-4 py-2.5 text-[12.5px] text-warn bg-warn/[0.06]">
            {t('sleep.pregenDisabledHint')}
          </div>
        )}

        <div className="px-4 py-3 space-y-2.5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-[13.5px] text-fg">{t('sleep.modeLabel')}</p>
          </div>
          <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-bg border border-line" role="radiogroup" aria-label={t('sleep.modeLabel')}>
            {modes.map(({ id, label, Icon, disabled }) => {
              const selected = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  title={disabled ? t('sleep.stopRequiresRouter') : undefined}
                  onClick={() => setMode(id)}
                  className={clsx(
                    'flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-md text-[12.5px] font-medium transition-colors',
                    selected ? 'bg-surface-2 text-fg ring-1 ring-line-strong' : 'text-fg-3 hover:text-fg',
                    disabled && 'opacity-40 cursor-not-allowed hover:text-fg-3',
                  )}
                >
                  <Icon size={13} strokeWidth={1.75} />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-fg-2 leading-relaxed">{activeDesc}</p>
          {!routerActive && (
            <p className="text-[11.5px] text-fg-3">{t('sleep.stopRequiresRouter')}</p>
          )}
        </div>

        {mode !== 'off' && (
          <div className="px-4 py-3 min-h-[52px] flex items-center justify-between gap-4">
            <div className="min-w-0">
              <label htmlFor="sleep-delay-input" className="text-[13.5px] text-fg block">{t('sleep.delayLabel')}</label>
              <p className="text-[12px] text-fg-3 mt-0.5">{t('sleep.delayHint')}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                id="sleep-delay-input"
                type="number"
                min={1}
                max={120}
                value={minutes}
                onChange={e => setMinutes(e.target.value)}
                className="h-8 w-20 px-2.5 rounded-md bg-bg border border-line-strong text-right text-[13px] text-fg outline-none focus:border-fg-2 font-mono transition-colors"
              />
              <span className="text-[12.5px] text-fg-2">{t('sleep.minutes')}</span>
            </div>
          </div>
        )}

        {routerActive && (
          <div className="px-4 py-3 space-y-2">
            <label htmlFor="sleep-hostname-input" className="text-[13.5px] text-fg block">
              {t('sleep.hostnameLabel')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="sleep-hostname-input"
                className="input font-mono text-[13px] flex-1"
                value={hostname}
                onChange={e => setHostname(e.target.value.toLowerCase())}
                placeholder={defaultSlug}
                maxLength={63}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="text-[12.5px] font-mono text-fg-3 shrink-0">
                .{routerSettings.domain}
              </span>
            </div>
            <p className="text-[12px] text-fg-3">
              {t('sleep.hostnameHint', { address: `${previewSub}.${routerSettings.domain}` })}
            </p>
          </div>
        )}
      </div>

      <p className="text-[12px] text-fg-3 px-1 leading-relaxed">{t('sleep.footer')}</p>
    </section>
  );
}
