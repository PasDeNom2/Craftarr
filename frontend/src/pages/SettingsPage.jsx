import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSources, updateSource } from '../services/api';
import { useI18n } from '../i18n';
import toast from 'react-hot-toast';

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
