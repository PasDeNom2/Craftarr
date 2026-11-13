import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Map as MapIcon, ExternalLink, AlertTriangle, Info, Loader2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useServerStore } from '../../../store';
import Switch from '../../ui/Switch';
import { getBluemapStatus, enableBluemap, disableBluemap } from '../../../services/features/bluemap';

export const block = { id: 'bluemap', order: 50 };

export default function BluemapSettings({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const patchStore = useServerStore(s => s.updateServer);

  const isVanilla = !server.loader_type || server.loader_type.toLowerCase() === 'vanilla';
  const isBusy = ['installing', 'updating'].includes(server.status);
  const isRunning = server.status === 'running';

  const { data: status } = useQuery({
    queryKey: ['bluemap', server.id],
    queryFn: () => getBluemapStatus(server.id),
    staleTime: 10000,
  });

  const enabled = status?.enabled ?? !!server.bluemap_enabled;
  const port = status?.port ?? server.bluemap_port;
  const mapUrl = port ? `http://${window.location.hostname}:${port}` : null;

  const toggleMut = useMutation({
    mutationFn: (next) => (next ? enableBluemap(server.id) : disableBluemap(server.id)),
    onSuccess: (res, next) => {
      if (res?.server) patchStore(server.id, res.server);
      qc.setQueryData(['bluemap', server.id], {
        enabled: !!res?.enabled,
        port: res?.port ?? null,
        installed: !!res?.installed,
      });
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      toast.success(t(next ? 'bluemap.enabledToast' : 'bluemap.disabledToast'));
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || t('common.error'));
    },
  });

  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold text-fg px-1 flex items-center gap-1.5">
        <MapIcon size={14} strokeWidth={1.75} className="text-fg-2" />
        {t('bluemap.title')}
      </h3>

      <div className="card !p-0 overflow-hidden divide-y divide-line">
        <div className="px-4 py-3 min-h-[52px] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13.5px] text-fg">{t('bluemap.enable')}</p>
            <p className="text-[12px] text-fg-3 mt-0.5">
              {isVanilla ? t('bluemap.vanillaUnsupported') : t('bluemap.enableHint')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {toggleMut.isPending && <Loader2 size={14} className="animate-spin text-fg-3" />}
            <Switch
              checked={enabled}
              onChange={(v) => toggleMut.mutate(v)}
              label={t('bluemap.enable')}
              disabled={isVanilla || isBusy || toggleMut.isPending}
            />
          </div>
        </div>

        {enabled && port && (
          <div className="fade-in divide-y divide-line">
            <div className="px-4 py-3 min-h-[52px] flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13.5px] text-fg">{t('bluemap.port')}</p>
                <p className="text-[12px] text-fg-3 mt-0.5 font-mono">{port}</p>
              </div>
              {isRunning && mapUrl && (
                <a
                  href={mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary !h-8 shrink-0"
                >
                  <ExternalLink size={13} strokeWidth={1.75} />
                  {t('bluemap.openMap')}
                </a>
              )}
            </div>

            <div className="px-4 py-3 flex items-start gap-2.5 text-[12px] text-warn bg-warn/[0.05]">
              <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />
              <span className="leading-relaxed">{t('bluemap.firewallWarning', { port })}</span>
            </div>
          </div>
        )}

        {(toggleMut.isSuccess || enabled) && server.needs_recreate && (
          <div className="px-4 py-3 flex items-start gap-2.5 text-[12px] text-fg-2">
            <Info size={14} strokeWidth={1.75} className="shrink-0 mt-0.5 text-fg-3" />
            <span className="leading-relaxed">{t('bluemap.recreateRequired')}</span>
          </div>
        )}
      </div>

      <p className="text-[12px] text-fg-3 px-1 leading-relaxed">{t('bluemap.renderNotice')}</p>
    </section>
  );
}
