import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSources, updateSource } from '../services/api';
import { useI18n } from '../i18n';
import { useThemeStore } from '../store';
import toast from 'react-hot-toast';
import clsx from 'clsx';

const THEMES = [
  {
    id: 'dark',
    label: 'Dark',
    bg: '#09090B',
    card: '#131316',
    accent: '#4ADE80',
  },
  {
    id: 'blue',
    label: 'Blue',
    bg: '#07101E',
    card: '#0D1828',
    accent: '#60A5FA',
  },
  {
    id: 'red',
    label: 'Red',
    bg: '#110808',
    card: '#1A0C0C',
    accent: '#F87171',
  },
  {
    id: 'daltonien',
    label: 'Daltonien',
    bg: '#09090B',
    card: '#131316',
    accent: '#F59E0B',
  },
];

function ThemePicker() {
  const { theme, setTheme } = useThemeStore();

  return (
    <div className="card">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {THEMES.map(t => {
          const active = theme === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className="relative rounded-xl overflow-hidden transition-all duration-200 text-left"
              style={{
                border: active ? `2px solid ${t.accent}` : '2px solid rgba(255,255,255,0.06)',
                boxShadow: active ? `0 0 12px rgba(${t.id === 'dark' ? '74,222,128' : t.id === 'blue' ? '96,165,250' : t.id === 'red' ? '248,113,113' : '245,158,11'},0.25)` : 'none',
              }}
            >
              {/* Preview */}
              <div className="h-16 p-2 flex flex-col gap-1.5" style={{ background: t.bg }}>
                <div className="rounded-md h-2 w-3/4" style={{ background: t.card }} />
                <div className="rounded-md h-2 w-1/2" style={{ background: t.card }} />
                <div className="rounded-full h-2 w-1/3 mt-auto" style={{ background: t.accent }} />
              </div>
              {/* Label */}
              <div
                className="px-2.5 py-1.5 flex items-center justify-between"
                style={{ background: t.card, borderTop: '1px solid rgba(255,255,255,0.06)' }}
              >
                <span className="text-xs font-medium text-[#F0F0F0]">{t.label}</span>
                {active && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: t.accent }}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-3">
      <h2
        className="text-xs font-semibold uppercase tracking-[0.1em] pb-2"
        style={{ color: '#6B6B76', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        {title}
      </h2>
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
        <p className="text-sm font-medium text-[#F0F0F0]">{label}</p>
        <p className="text-xs text-[#6B6B76] mt-0.5">{description}</p>
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
    <div className="p-7 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-[#F0F0F0] tracking-tight mb-1">{t('settings.title')}</h1>
        <p className="text-[#6B6B76] text-sm">{t('settings.subtitle')}</p>
      </div>

      <Section title={t('settings.appearance') || 'Appearance'}>
        <ThemePicker />
      </Section>

      <Section title={t('settings.apiKeys')}>
        <ApiKeyField
          sourceId="curseforge"
          label="CurseForge API Key"
          description={t('settings.curseforgeDesc')}
        />
        <ApiKeyField
          sourceId="modrinth"
          label={t('settings.modrinthOptional')}
          description={t('settings.modrinthDesc')}
        />
      </Section>

      <Section title="System">
        <div className="card space-y-3 text-sm">
          {[
            ['Version', '1.0.0'],
            ['Backend', 'Node.js + Express'],
            ['Image Minecraft', 'itzg/minecraft-server'],
            ['Database', 'SQLite'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
              <span className="text-[#6B6B76]">{k}</span>
              <span className="text-[#F0F0F0] font-medium font-mono text-xs">{v}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
