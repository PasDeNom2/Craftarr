import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSources, updateSource } from '../services/api';
import { useI18n } from '../i18n';
import { useThemeStore } from '../store';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import ApiSourceList from '../components/settings/ApiSourceList';

// Aperçus des thèmes (doivent correspondre aux blocs [data-theme] de index.css)
const THEMES = [
  { id: 'dark',      label: 'Deepslate',  bg: '#0A0D12', card: '#121821', line: '#1F2835', accent: '#3DDC84' },
  { id: 'blue',      label: 'Prismarine', bg: '#08111C', card: '#0F1D2E', line: '#1C3247', accent: '#4FC3F7' },
  { id: 'red',       label: 'Nether',     bg: '#120909', card: '#1E0F0F', line: '#331B1B', accent: '#FF7A59' },
  { id: 'daltonien', label: 'Daltonien',  bg: '#0C0C0E', card: '#16161A', line: '#27272F', accent: '#F5A524' },
];

function ThemePicker() {
  const { theme, setTheme } = useThemeStore();

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {THEMES.map(th => {
        const active = theme === th.id;
        return (
          <button
            key={th.id}
            onClick={() => setTheme(th.id)}
            aria-pressed={active}
            className="group relative rounded-xl overflow-hidden text-left transition-transform duration-200 hover:-translate-y-0.5"
            style={{
              boxShadow: active ? `0 0 0 2px ${th.accent}, 0 10px 30px -12px ${th.accent}` : '0 0 0 1px var(--line)',
            }}
          >
            {/* Mini-interface du thème */}
            <div className="h-24 flex" style={{ background: th.bg }}>
              <div className="w-7 h-full flex flex-col items-center gap-1.5 pt-2" style={{ background: th.card, borderRight: `1px solid ${th.line}` }}>
                <span className="w-3 h-3 rounded-[3px]" style={{ background: th.accent }} />
                <span className="w-3 h-1 rounded-sm" style={{ background: th.line }} />
                <span className="w-3 h-1 rounded-sm" style={{ background: th.line }} />
              </div>
              <div className="flex-1 p-2.5 flex flex-col gap-1.5"
                style={{ backgroundImage: `linear-gradient(${th.line} 1px, transparent 1px), linear-gradient(90deg, ${th.line} 1px, transparent 1px)`, backgroundSize: '12px 12px' }}>
                <div className="rounded h-2.5 w-2/3" style={{ background: th.card, border: `1px solid ${th.line}` }} />
                <div className="rounded h-2.5 w-1/2" style={{ background: th.card, border: `1px solid ${th.line}` }} />
                <div className="rounded h-3 w-10 mt-auto" style={{ background: th.accent, boxShadow: `0 0 10px ${th.accent}` }} />
              </div>
            </div>
            <div className="px-3 py-2 flex items-center justify-between" style={{ background: th.card, borderTop: `1px solid ${th.line}` }}>
              <span className="text-xs font-medium" style={{ color: '#E7EDF4' }}>{th.label}</span>
              {active && <span className="status-block" style={{ color: th.accent, width: 7, height: 7 }} />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-3">
      <h2 className="eyebrow pb-2 border-b border-line">{title}</h2>
      {children}
    </div>
  );
}

function ApiKeyField({ sourceId, label, description }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const { t } = useI18n();

  const save = useMutation({
    mutationFn: () => updateSource(sourceId, { api_key: value }),
    onSuccess: () => {
      setSaved(true);
      setValue('');
      toast.success(t('settings.saveSuccess'));
      qc.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: () => toast.error(t('settings.saveError')),
  });

  return (
    <div className="card space-y-3">
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="text-xs text-fg-2 mt-0.5">{description}</p>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          className="input flex-1"
          value={value}
          onChange={e => { setValue(e.target.value); setSaved(false); }}
          placeholder={saved ? '••••••••••••••••' : t('settings.enterKey')}
        />
        <button
          className="btn-primary shrink-0"
          onClick={() => save.mutate()}
          disabled={!value || save.isPending}
        >
          {save.isPending ? t('settings.saving') : t('settings.save')}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useI18n();

  return (
    <div className="px-8 py-8 max-w-4xl mx-auto space-y-10">
      <header className="card-in">
        <p className="eyebrow mb-2">{t('nav.settings')}</p>
        <h1 className="font-display text-[34px] leading-none font-semibold text-fg tracking-tight">{t('settings.title')}</h1>
        <p className="text-fg-2 text-sm mt-3">{t('settings.subtitle')}</p>
      </header>

      <Section title={t('settings.appearance')}>
        <ThemePicker />
      </Section>

      <Section title={t('settings.apiKeys')}>
        <ApiKeyField sourceId="curseforge" label="CurseForge API Key" description={t('settings.curseforgeDesc')} />
        <ApiKeyField sourceId="modrinth" label={t('settings.modrinthOptional')} description={t('settings.modrinthDesc')} />
      </Section>

      <Section title={t('settings.apiSources')}>
        <ApiSourceList />
      </Section>

      <Section title={t('settings.system')}>
        <div className="card !p-0 divide-y divide-line text-sm">
          {[
            ['Backend', 'Node.js 24 · Express · Socket.io'],
            ['Minecraft', 'itzg/minecraft-server'],
            ['Database', 'SQLite'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between px-5 py-3">
              <span className="text-fg-2">{k}</span>
              <span className="text-fg font-mono text-xs">{v}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
