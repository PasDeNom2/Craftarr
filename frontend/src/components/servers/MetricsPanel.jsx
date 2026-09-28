import React, { useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useServerSocket } from '../../hooks/useSocket';
import { useMetricsStore } from '../../store';
import { useI18n } from '../../i18n';
import clsx from 'clsx';
import { Activity } from 'lucide-react';

const MAX_HISTORY = 60;

function StatCard({ label, value, unit, sub, valueColor = 'var(--fg)' }) {
  return (
    <div
      className="rounded-xl p-4 space-y-3"
      style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <p className="text-[11px] text-fg-2 uppercase tracking-[0.1em] font-medium">{label}</p>
      <p className="font-semibold tabular-nums leading-none" style={{ fontSize: '26px', color: valueColor }}>
        {value}
        {unit && <span className="text-sm font-normal text-fg-2 ml-1.5">{unit}</span>}
      </p>
      {sub && <p className="text-xs text-fg-3 font-mono">{sub}</p>}
    </div>
  );
}

const CHART_TOOLTIP = {
  contentStyle: {
    background: 'var(--bg-card)',
    border: '1px solid rgba(255,255,255,0.08)',
    fontSize: 11,
    borderRadius: 8,
    color: 'var(--fg)',
  },
  labelStyle: { color: 'var(--fg-2)' },
};

function MiniChart({ data, dataKey, stroke, gradientId, label, formatter, domain }) {
  return (
    <div className="card !p-4">
      <p className="eyebrow mb-3 flex items-center gap-2"><span className="status-block" style={{ color: stroke, width: 6, height: 6 }} />{label}</p>
      <ResponsiveContainer width="100%" height={120}>
        <AreaChart data={data} margin={{ top: 2, right: 4, left: -24, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={stroke} stopOpacity={0.28} />
              <stop offset="95%" stopColor={stroke} stopOpacity={0}   />
            </linearGradient>
          </defs>
          <XAxis dataKey="time" tick={{ fontSize: 9, fill: 'var(--fg-3)' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: 'var(--fg-3)' }} domain={domain} />
          <Tooltip {...CHART_TOOLTIP} formatter={formatter} />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={stroke}
            fill={`url(#${gradientId})`}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function MetricsPanel({ server }) {
  const { t } = useI18n();
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
          time: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        },
      ];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  };

  useServerSocket(server.id, server.container_id, { metrics: handleMetrics });

  const tps = current?.tps?.tps1;
  const tpsColor = tps == null ? 'var(--fg-2)' : tps >= 18 ? 'var(--accent)' : tps >= 12 ? 'var(--warn)' : 'var(--danger)';
  const cpuVal = current?.cpu ?? 0;
  const cpuColor = cpuVal > 80 ? 'var(--danger)' : cpuVal > 50 ? 'var(--warn)' : 'var(--fg)';
  const isRunning = server.status === 'running';

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label={t('metrics.players')}
          value={current?.players?.online ?? '—'}
          unit={`/ ${current?.players?.max ?? server.max_players}`}
          valueColor="var(--accent)"
        />
        <StatCard
          label={t('metrics.ram')}
          value={current?.memUsed ?? '—'}
          unit={t('metrics.mb')}
          sub={current ? `${current.memPercent}% / ${current.memLimit} ${t('metrics.mb')}` : null}
        />
        <StatCard
          label={t('metrics.cpu')}
          value={current?.cpu != null ? current.cpu.toFixed(1) : '—'}
          unit="%"
          valueColor={cpuColor}
        />
        <StatCard
          label={t('metrics.tps')}
          value={tps != null ? tps.toFixed(1) : '—'}
          unit="TPS"
          valueColor={tpsColor}
          sub={current?.tps?.tps5 != null ? t('metrics.tpsSub', { tps5: current.tps.tps5.toFixed(1), tps15: current.tps.tps15?.toFixed(1) }) : null}
        />
      </div>

      {/* Graphs */}
      {history.length > 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MiniChart
            data={history}
            dataKey="memUsed"
            stroke="var(--fg)"
            gradientId="ramGrad"
            label={t('metrics.ramLabel')}
            formatter={(v) => [`${v} ${t('metrics.mb')}`, 'RAM']}
          />
          <MiniChart
            data={history}
            dataKey="cpu"
            stroke="var(--accent)"
            gradientId="cpuGrad"
            label={t('metrics.cpuLabel')}
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
            <Activity size={18} strokeWidth={1.5} className="text-fg-3" />
          </div>
          <p className="text-fg-2 text-sm">{t('metrics.startServer')}</p>
        </div>
      )}

      {isRunning && history.length === 0 && (
        <div className="text-center py-8 text-fg-2 text-sm space-y-2">
          <div className="w-5 h-5 border border-fg-3 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderTopColor: 'transparent' }} />
          <span>{t('metrics.waiting')}</span>
        </div>
      )}
    </div>
  );
}
