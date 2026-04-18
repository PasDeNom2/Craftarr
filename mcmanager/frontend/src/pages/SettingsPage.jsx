import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSources, updateSource } from '../services/api';
import ApiSourceList from '../components/settings/ApiSourceList';
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

  const save = useMutation({
    mutationFn: () => updateSource(sourceId, { api_key: value }),
    onSuccess: () => {
      setSaved(true);
      setValue('');
      toast.success(`Clé ${label} enregistrée`);
      qc.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: () => toast.error('Erreur lors de la sauvegarde'),
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
          placeholder={saved ? '••••••••••••••••' : 'Entrez votre clé API...'}
        />
        <button
          className="btn-primary shrink-0"
          onClick={() => save.mutate()}
          disabled={!value || save.isPending}
        >
          {save.isPending ? 'Sauvegarde...' : 'Sauvegarder'}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="p-7 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-[#F0F0F0] tracking-tight mb-1">Paramètres</h1>
        <p className="text-[#6B6B76] text-sm">Configuration globale de MCManager</p>
      </div>

      <Section title="Clés API">
        <ApiKeyField
          sourceId="curseforge"
          label="CurseForge API Key"
          description="Obtenez votre clé sur console.curseforge.com — requise pour accéder au catalogue CurseForge"
        />
        <ApiKeyField
          sourceId="modrinth"
          label="Modrinth API Key (optionnelle)"
          description="Améliore le rate limit pour les recherches Modrinth. Disponible sur modrinth.com/settings/pats"
        />
      </Section>

      <Section title="Sources de modpacks">
        <p className="text-xs text-[#6B6B76]">
          Activez ou désactivez des sources, ajoutez des APIs tierces.
          Le catalogue agrège toutes les sources actives en une vue unifiée.
        </p>
        <ApiSourceList />
      </Section>

      <Section title="Informations système">
        <div className="card space-y-3 text-sm">
          {[
            ['Version MCManager', '1.0.0'],
            ['Backend', 'Node.js + Express'],
            ['Image Minecraft', 'itzg/minecraft-server'],
            ['Base de données', 'SQLite'],
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
