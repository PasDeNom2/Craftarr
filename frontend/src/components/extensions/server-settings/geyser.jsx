import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Copy, Check, AlertTriangle, Globe, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useServerStore } from '../../../store';
import Switch from '../../ui/Switch';
import { getGeyserStatus, enableGeyser, disableGeyser } from '../../../services/features/geyser';

const SUPPORTED_LOADERS = new Set(['fabric', 'neoforge', 'paper', 'purpur']);

export const block = {
  id: 'geyser',
  order: 20,
};

export default function GeyserSettingsBlock({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const patchStore = useServerStore(s => s.updateServer);
  const [floodgateDraft, setFloodgateDraft] = useState(null);
  const [copied, setCopied] = useState(false);

  const { data } = useQuery({
    queryKey: ['geyser', server.id],
    queryFn: () => getGeyserStatus(server.id),
  });

  const supportedFallback = SUPPORTED_LOADERS.has((server.loader_type || '').toLowerCase());
  const supported = data ? !!data.supported : supportedFallback;
  const reason = data?.reason || (!supported ? t('geyser.unsupportedDefault') : null);
  const enabled = data ? !!data.enabled : !!server.geyser_enabled;
  const port = data ? data.port : (server.geyser_port || null);
  const floodgateServer = data ? !!data.floodgate : (server.geyser_floodgate !== 0);
  const floodgate = enabled ? floodgateServer : (floodgateDraft ?? floodgateServer);
  const isServerBusy = ['installing', 'updating'].includes(server.status);

  function syncServerState(res) {
    qc.invalidateQueries({ queryKey: ['geyser', server.id] });
    qc.invalidateQueries({ queryKey: ['server', server.id] });
    patchStore(server.id, {
      geyser_enabled: res.enabled,
      geyser_port: res.port,
      geyser_floodgate: res.floodgate,
      needs_recreate: res.needs_recreate,
    });
  }

  const enableMut = useMutation({
    mutationFn: ({ nextFloodgate }) => enableGeyser(server.id, { floodgate: nextFloodgate }),
    onSuccess: (res, vars) => {
      setFloodgateDraft(null);
      syncServerState(res);
      toast.success(vars.floodgateOnly ? t('geyser.floodgateUpdatedToast') : t('geyser.enabledToast'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const disableMut = useMutation({
    mutationFn: () => disableGeyser(server.id),
    onSuccess: (res) => {
      setFloodgateDraft(null);
      syncServerState(res);
      toast.success(t('geyser.disabledToast'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const busy = enableMut.isPending || disableMut.isPending;

  function handleToggle(next) {
    if (!supported || busy || isServerBusy) return;
    if (next) {
      enableMut.mutate({ nextFloodgate: floodgate, floodgateOnly: false });
    } else {
      disableMut.mutate();
    }
  }

  function handleFloodgateChange(next) {
    if (!supported || busy || isServerBusy) return;
    if (enabled) {
      enableMut.mutate({ nextFloodgate: next, floodgateOnly: true });
    } else {
      setFloodgateDraft(next);
    }
  }

  const bedrockAddress = port ? `${window.location.hostname}:${port}` : null;

  async function copyBedrockAddress() {
    if (!bedrockAddress) return;
    try {
      await navigator.clipboard.writeText(bedrockAddress);
      setCopied(true);
      toast.success(t('geyser.addressCopied', { address: bedrockAddress }));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast(bedrockAddress);
    }
  }

  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold text-fg px-1">{t('geyser.title')}</h3>
      <div className={clsx('card !p-0 overflow-hidden divide-y divide-line', !supported && 'opacity-60')}>
        <div className="px-4 py-3 min-h-[52px] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13.5px] text-fg">{t('geyser.enable')}</p>
            <p className="text-[12px] text-fg-3 mt-0.5">
              {supported ? t('geyser.enableHint') : reason}
            </p>
          </div>
          <Switch
            checked={enabled}
            onChange={handleToggle}
            label={t('geyser.enable')}
            disabled={!supported || busy || isServerBusy}
          />
        </div>

        {supported && (
          <div className="px-4 py-3 min-h-[52px] flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13.5px] text-fg flex items-center gap-1.5">
                <ShieldCheck size={14} strokeWidth={1.75} className="text-fg-2 shrink-0" />
                <span>{t('geyser.floodgate')}</span>
              </p>
              <p className="text-[12px] text-fg-3 mt-0.5">{t('geyser.floodgateHint')}</p>
            </div>
            <Switch
              checked={floodgate}
              onChange={handleFloodgateChange}
              label={t('geyser.floodgate')}
              disabled={busy || isServerBusy}
            />
          </div>
        )}

        {supported && enabled && port && (
          <div className="fade-in divide-y divide-line">
            <div className="px-4 py-3 min-h-[52px] flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13.5px] text-fg flex items-center gap-1.5">
                  <Globe size={14} strokeWidth={1.75} className="text-fg-2 shrink-0" />
                  <span>{t('geyser.addressLabel')}</span>
                </p>
                <p className="text-[12px] text-fg-3 mt-0.5">{t('geyser.addressHint')}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <code className="px-2.5 py-1 rounded-md bg-bg border border-line-strong font-mono text-[13px] text-fg">
                  {bedrockAddress}
                </code>
                <button
                  type="button"
                  onClick={copyBedrockAddress}
                  className="icon-btn"
                  title={t('geyser.copyAddress')}
                  aria-label={t('geyser.copyAddress')}
                >
                  {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div className="px-4 py-3 text-[12.5px] text-fg-2 space-y-1">
              <p className="font-medium text-fg">{t('geyser.udpPortLabel')}</p>
              <p className="text-fg-3 leading-relaxed">{t('geyser.udpPortHint', { port })}</p>
            </div>
          </div>
        )}

        {(server.needs_recreate || data?.needs_recreate) && supported && (
          <div
            className="flex items-start gap-2.5 px-4 py-3 text-[12.5px]"
            style={{ background: 'rgba(var(--warn-rgb),0.08)', color: 'var(--warn)' }}
          >
            <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />
            <span>{t('geyser.recreateNotice')}</span>
          </div>
        )}
      </div>
      <p className="text-[12px] text-fg-3 px-1 leading-relaxed">
        {enabled && port ? t('geyser.footer', { port }) : t('geyser.footerDisabled')}
      </p>
    </section>
  );
}
