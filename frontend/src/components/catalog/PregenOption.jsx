import React from 'react';
import { Mountain } from 'lucide-react';
import { useI18n } from '../../i18n';
import Switch from '../ui/Switch';
import Segmented from '../ui/Segmented';

const RADII = [1000, 2000, 3000, 5000, 10000];

/** Case « pré-générer le monde » de la fenêtre de déploiement. */
export default function PregenOption({ form, set, vanilla }) {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/[0.07] overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="w-8 h-8 rounded-[10px] bg-white/[0.08] flex items-center justify-center shrink-0 text-accent">
          <Mountain size={15} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-fg">{t('pregen.enable')}</p>
          <p className="text-[11.5px] text-fg-3 mt-0.5">{t('pregen.enableHint')}</p>
        </div>
        <Switch checked={form.pregen_enabled} onChange={v => set('pregen_enabled', v)} label={t('pregen.enable')} />
      </div>
      {form.pregen_enabled && (
        <div className="px-4 pb-3.5 space-y-2 fade-in">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] text-fg-2">{t('pregen.radius')}</span>
            <span className="text-[11px] text-fg-3">{t('pregen.radiusHint', { size: (form.pregen_radius * 2).toLocaleString() })}</span>
          </div>
          <Segmented
            size="sm"
            className="w-full [&>button]:flex-1"
            value={form.pregen_radius}
            onChange={v => set('pregen_radius', v)}
            items={RADII.map(r => ({ id: r, label: `${r / 1000}k` }))}
          />
          {vanilla && <p className="text-[11px] text-fg-3 leading-relaxed">{t('pregen.vanillaNote')}</p>}
        </div>
      )}
    </div>
  );
}
