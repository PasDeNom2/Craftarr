import React, { useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useServerSocket } from '../../hooks/useSocket';
import { useMetricsStore } from '../../store';
import clsx from 'clsx';
import { Activity } from 'lucide-react';

const MAX_HISTORY = 60;

function StatCard({ label, value, unit, sub, valueColor = '#F0F0F0' }) {
  return (
    <div
      className="rounded-xl p-4 space-y-3"
      style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <p className="text-[11px] text-[#6B6B76] uppercase tracking-[0.1em] font-medium">{label}</p>
      <p className="font-semibold tabular-nums leading-none" style={{ fontSize: '26px', color: valueColor }}>
        {value}
        {unit && <span className="text-sm font-normal text-[#6B6B76] ml-1.5">{unit}</span>}
      </p>
      {sub && <p className="text-xs text-[#4A4A55] font-mono">{sub}</p>}
    </div>
  );
}

const CHART_TOOLTIP = {
  contentStyle: {
    background: 'var(--bg-card)',
    border: '1px solid rgba(255,255,255,0.08)',
    fontSize: 11,
    borderRadius: 8,
    color: '#F0F0F0',
  },
  labelStyle: { color: '#6B6B76' },
};

function MiniChart({ data, dataKey, stroke, gradientId, label, formatter, domain }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-[11px] text-[#6B6B76] uppercase tracking-[0.1em] font-medium mb-3">{label}</p>
      <ResponsiveContainer width="100%" height={120}>
        <AreaChart data={data} margin={{ top: 2, right: 4, left: -24, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={stroke} stopOpacity={0.2} />
              <stop offset="95%" stopColor={stroke} stopOpacity={0}   />
            </linearGradient>
          </defs>
          <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#4A4A55' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: '#4A4A55' }} domain={domain} />
          <Tooltip {...CHART_TOOLTIP} formatter={formatter} />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={stroke}
            fill={`url(#${gradientId})`}
            strokeWidth={1.5}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function MetricsPanel({ server }) {
  const [history, setHistory] = useState([]);
  const { updateMetrics, metrics } = useMetricsStore();
  const current = metrics[server.id] || null;

  const handleMetrics = (data) => {
    if (data.serverId !== server.id) return;
    updateMetrics(server.id, data);
    setHistory(prev => {
      const next = [
        ...prev,
        {
          ...data,
          time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        },
      ];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  };

  useServerSocket(server.id, server.container_id, { metrics: handleMetrics });

  const tps = current?.tps?.tps1;
  const tpsColor = tps == null ? '#6B6B76' : tps >= 18 ? 'var(--accent)' : tps >= 12 ? '#FBBF24' : '#F87171';
  const cpuVal = current?.cpu ?? 0;
  const cpuColor = cpuVal > 80 ? '#F87171' : cpuVal > 50 ? '#FBBF24' : '#F0F0F0';
  const isRunning = server.status === 'running';

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Joueurs"
          value={current?.players?.online ?? (isRunning ? '—' : '—')}
          unit={`/ ${current?.players?.max ?? server.max_players}`}
          valueColor="var(--accent)"
        />
        <StatCard
          label="RAM"
          value={current?.memUsed ?? '—'}
          unit="Mo"
          sub={current ? `${current.memPercent}% de ${current.memLimit} Mo` : null}
        />
        <StatCard
          label="CPU"
          value={current?.cpu != null ? current.cpu.toFixed(1) : '—'}
          unit="%"
          valueColor={cpuColor}
        />
        <StatCard
          label="TPS 1 min"
          value={tps != null ? tps.toFixed(1) : '—'}
          unit="TPS"
          valueColor={tpsColor}
          sub={current?.tps ? `5m: ${current.tps.tps5?.toFixed(1)} · 15m: ${current.tps.tps15?.toFixed(1)}` : null}
        />
      </div>

      {/* Graphs */}
      {history.length > 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MiniChart
            data={history}
            dataKey="memUsed"
            stroke="#F0F0F0"
            gradientId="ramGrad"
            label="RAM (Mo)"
            formatter={(v) => [`${v} Mo`, 'RAM']}
          />
          <MiniChart
            data={history}
            dataKey="cpu"
            stroke="var(--accent)"
            gradientId="cpuGrad"
            label="CPU (%)"
            formatter={(v) => [`${v?.toFixed(1)}%`, 'CPU']}
            domain={[0, 100]}
          />
        </div>
      )}

      {!isRunning && (
        <div className="text-center py-12 space-y-3">
          <div
            className="w-10 h-10 rounded-xl mx-auto flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <Activity size={18} strokeWidth={1.5} className="text-[#4A4A55]" />
          </div>
          <p className="text-[#6B6B76] text-sm">Démarrez le serveur pour voir les métriques en temps réel.</p>
        </div>
      )}

      {isRunning && history.length === 0 && (
        <div className="text-center py-8 text-[#6B6B76] text-sm space-y-2">
          <div className="w-5 h-5 border border-[#4A4A55] border-t-transparent rounded-full animate-spin mx-auto" style={{ borderTopColor: 'transparent' }} />
          <span>En attente des premières métriques...</span>
        </div>
      )}
    </div>
  );
}
