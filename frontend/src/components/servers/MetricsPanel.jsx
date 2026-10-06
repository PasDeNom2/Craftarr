import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useMetricsStore } from '../../store';
import { useI18n } from '../../i18n';
import { Activity, Users, MemoryStick, Cpu, Gauge } from 'lucide-react';

// Les points arrivent via la console (toujours montée sur la page serveur) : l'historique
// vit dans le store et survit aux changements d'onglet.
const EMPTY = [];

function StatCard({ icon: Icon, label, value, unit, sub, tone = 'var(--fg)', progress }) {
  return (
    <div className="card !p-4 space-y-3 min-w-0">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-[9px] flex items-center justify-center bg-tint/[0.07]" style={{ color: tone }}>
          <Icon size={14} strokeWidth={2} />
        </span>
        <p className="text-[12px] text-fg-2 font-medium truncate">{label}</p>
      </div>
      <p className="font-semibold tabular-nums leading-none text-[28px] tracking-tight" style={{ color: tone }}>
        {value}
        {unit && <span className="text-[13px] font-medium text-fg-3 ml-1.5">{unit}</span>}
      </p>
      {progress != null ? (
        <div className="h-1.5 rounded-full bg-tint/[0.08] overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, progress)}%`, background: tone }} />
        </div>
      ) : (
        <p className="text-[11px] text-fg-3 font-mono h-1.5 leading-none">{sub}</p>
      )}
    </div>
  );
}

function ChartTooltip({ active, payload, unit, label: name }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="glass-strong rounded-xl px-3 py-2 text-[11px]">
      <p className="text-fg-3 font-mono">{new Date(p.payload.t).toLocaleTimeString()}</p>
      <p className="text-fg font-semibold mt-0.5">{name} · {p.value}{unit}</p>
    </div>
  );
}

function Chart({ data, dataKey, color, id, label, unit = '', domain, current }) {
  return (
    <div className="card !p-4 !pb-2">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-[12px] text-fg-2 font-medium flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
          {label}
        </p>
        <p className="text-[13px] font-semibold font-mono text-fg tabular-nums">{current ?? '—'}<span className="text-fg-3 font-normal">{unit}</span></p>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <AreaChart data={data} margin={{ top: 4, right: 2, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} hide />
          <YAxis tick={{ fontSize: 9, fill: 'rgba(235,235,245,0.3)' }} domain={domain} axisLine={false} tickLine={false} width={34} tickFormatter={v => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : v)} />
          <Tooltip content={<ChartTooltip unit={unit} label={label} />} cursor={{ stroke: 'rgba(var(--tint-rgb),0.2)', strokeDasharray: '3 3' }} />
          <Area type="monotone" dataKey={dataKey} stroke={color} fill={`url(#${id})`} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function MetricsPanel({ server }) {
  const { t } = useI18n();
  const current = useMetricsStore(s => s.metrics[server.id]) || null;
  const history = useMetricsStore(s => s.history[server.id]) || EMPTY;

  const tps = current?.tps?.tps1;
  const tpsColor = tps == null ? 'var(--fg-2)' : tps >= 18 ? 'var(--success)' : tps >= 12 ? 'var(--warn)' : 'var(--danger)';
  const cpuVal = current?.cpu ?? 0;
  const cpuColor = cpuVal > 80 ? 'var(--danger)' : cpuVal > 50 ? 'var(--warn)' : 'var(--info)';
  const memPct = current?.memPercent != null ? +current.memPercent : null;
  const memColor = memPct > 90 ? 'var(--danger)' : memPct > 75 ? 'var(--warn)' : 'var(--purple)';
  const isRunning = server.status === 'running';
  const maxPlayers = current?.players?.max ?? server.max_players;
  const span = history.length > 1 ? Math.round((history[history.length - 1].t - history[0].t) / 60000) : 0;
  const memDomain = useMemo(() => [0, current?.memLimit || 'auto'], [current?.memLimit]);

  if (!isRunning && !history.length) {
    return (
      <div className="card flex flex-col items-center justify-center text-center py-16 gap-3 max-w-4xl">
        <span className="w-14 h-14 rounded-2xl bg-tint/[0.06] flex items-center justify-center text-fg-3"><Activity size={24} strokeWidth={1.5} /></span>
        <p className="text-fg-2 text-sm">{t('metrics.startServer')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 stagger">
        <StatCard icon={Users} label={t('metrics.players')} value={current?.players?.online ?? '—'} unit={`/ ${maxPlayers}`}
          tone="var(--accent)" progress={current?.players ? (current.players.online / maxPlayers) * 100 : 0} />
        <StatCard icon={MemoryStick} label={t('metrics.ram')} value={current?.memUsed != null ? (current.memUsed / 1024).toFixed(1) : '—'} unit={`/ ${current?.memLimit ? (current.memLimit / 1024).toFixed(0) : '—'} Go`}
          tone={memColor} progress={memPct ?? 0} />
        <StatCard icon={Cpu} label={t('metrics.cpu')} value={current?.cpu != null ? current.cpu.toFixed(1) : '—'} unit="%"
          tone={cpuColor} progress={Math.min(100, cpuVal)} />
        <StatCard icon={Gauge} label={t('metrics.tps')} value={tps != null ? tps.toFixed(1) : '—'} unit="/ 20"
          tone={tpsColor} progress={tps != null ? (tps / 20) * 100 : 0} />
      </div>

      {history.length > 1 ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Chart data={history} dataKey="memUsed" color="var(--purple)" id="g-ram" label={t('metrics.ramLabel')} unit=" Mo" domain={memDomain} current={current?.memUsed} />
            <Chart data={history} dataKey="cpu" color="var(--info)" id="g-cpu" label={t('metrics.cpuLabel')} unit=" %" domain={[0, dataMax => Math.max(100, Math.ceil(dataMax))]} current={current?.cpu?.toFixed(1)} />
            <Chart data={history} dataKey="tps" color="var(--success)" id="g-tps" label="TPS" domain={[0, 20]} current={tps?.toFixed(1)} />
            <Chart data={history} dataKey="players" color="var(--orange)" id="g-players" label={t('metrics.players')} domain={[0, dataMax => Math.max(4, dataMax + 1)]} current={current?.players?.online} />
          </div>
          <p className="text-[11px] text-fg-3 px-1">{t('metrics.historySpan', { minutes: Math.max(1, span) })}</p>
        </>
      ) : (
        <div className="card flex items-center justify-center gap-2.5 py-10 text-fg-2 text-sm">
          <span className="w-4 h-4 border-2 border-tint/20 border-t-tint/70 rounded-full animate-spin" />
          {t('metrics.waiting')}
        </div>
      )}
    </div>
  );
}
