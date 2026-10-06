import React from 'react';
import { Mountain } from 'lucide-react';
import { useI18n } from '../../i18n';
import Switch from '../ui/Switch';
import Segmented from '../ui/Segmented';

const RADII = [1000, 2000, 3000, 5000, 10000];

export const PREGEN_WORLDS = [
  { id: 'minecraft:overworld', key: 'overworld' },
  { id: 'minecraft:the_nether', key: 'nether' },
  { id: 'minecraft:the_end', key: 'end' },
];

/** Choix des dimensions à pré-générer (au moins une). */
export function PregenWorlds({ value = [], onChange }) {
  const { t } = useI18n();
  const toggle = (id) => {
    const next = value.includes(id) ? value.filter(w => w !== id) : [...value, id];
    if (next.length) onChange(PREGEN_WORLDS.map(w => w.id).filter(w => next.includes(w)));
  };
  return (
    <div className="flex gap-1.5">
      {PREGEN_WORLDS.map(w => {
        const on = value.includes(w.id);
        return (
          <button
            key={w.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(w.id)}
            className={`flex-1 h-8 rounded-md text-[12px] font-medium border transition-colors ${
              on ? 'bg-fg border-fg text-inverse' : 'border-line-strong text-fg-2 hover:text-fg hover:border-fg-3'
            }`}
          >
            {t(`pregen.worlds.${w.key}`)}
          </button>
        );
      })}
    </div>
  );
}

/** Case « pré-générer le monde » de la fenêtre de déploiement. */
export default function PregenOption({ form, set, vanilla }) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-line overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="w-8 h-8 rounded-lg border border-line-strong flex items-center justify-center shrink-0 text-fg-2">
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
          <p className="text-[12px] text-fg-2 pt-1">{t('pregen.worldsLabel')}</p>
          <PregenWorlds value={form.pregen_worlds} onChange={v => set('pregen_worlds', v)} />
          {vanilla && <p className="text-[11px] text-fg-3 leading-relaxed">{t('pregen.vanillaNote')}</p>}
        </div>
      )}
    </div>
  );
}
