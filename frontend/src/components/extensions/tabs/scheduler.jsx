import React, { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  Clock,
  HardDrive,
  History,
  MessageSquare,
  MinusCircle,
  Pencil,
  Play,
  Plus,
  Power,
  Sparkles,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  createSchedule,
  deleteSchedule,
  getSchedulePresets,
  getScheduleRuns,
  getSchedules,
  runSchedule,
  updateSchedule,
} from '../../../services/features/scheduler';
import { useI18n } from '../../../i18n';
import Modal from '../../ui/Modal';
import ConfirmDialog from '../../ui/ConfirmDialog';
import Switch from '../../ui/Switch';
import Segmented from '../../ui/Segmented';
import { parseDbDate } from '../../../utils/dates';
import { useDateLocale } from '../../../utils/dateLocale';

export const tab = {
  id: 'schedules',
  Icon: CalendarClock,
  labelKey: 'scheduler.tab',
  order: 45,
};

const EVENTS = [
  'server:started',
  'server:stopped',
  'server:crashed',
  'player:join',
  'player:leave',
  'server:empty',
];

const STEP_ICONS = {
  command: Terminal,
  say: MessageSquare,
  wait: Clock,
  power: Power,
  backup: HardDrive,
};

const STATUS_STYLE = {
  success: { icon: CheckCircle2, color: 'var(--success)', rgb: 'var(--success-rgb)' },
  failed: { icon: XCircle, color: 'var(--danger)', rgb: 'var(--danger-rgb)' },
  skipped: { icon: MinusCircle, color: 'var(--warn)', rgb: 'var(--warn-rgb)' },
};

const FALLBACK_PRESETS = [
  {
    id: 'announced-restart',
    name: 'Redémarrage annoncé',
    trigger_type: 'cron',
    cron: '0 4 * * *',
    only_if_players: 'any',
    steps: [
      { type: 'say', message: 'Redémarrage du serveur dans 5 minutes' },
      { type: 'wait', seconds: 240 },
      { type: 'say', message: 'Redémarrage du serveur dans 1 minute' },
      { type: 'wait', seconds: 60 },
      { type: 'power', action: 'restart' },
    ],
  },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Détecte si une expression cron correspond aux raccourcis quotidien ou hebdomadaire. */
function detectCronShortcut(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*' && parts[3] === '*') {
    const mm = Number(parts[0]);
    const hh = Number(parts[1]);
    if (mm >= 0 && mm <= 59 && hh >= 0 && hh <= 23) {
      const time = `${pad2(hh)}:${pad2(mm)}`;
      if (parts[4] === '*') return { mode: 'daily', time, day: '1' };
      if (/^[0-7]$/.test(parts[4])) {
        return { mode: 'weekly', time, day: parts[4] === '7' ? '0' : parts[4] };
      }
    }
  }
  return { mode: 'custom', time: '04:00', day: '1' };
}

function buildCronFromShortcut(mode, time, day) {
  const [hhStr = '04', mmStr = '00'] = String(time || '04:00').split(':');
  const hh = Number(hhStr) || 0;
  const mm = Number(mmStr) || 0;
  if (mode === 'weekly') return `${mm} ${hh} * * ${day}`;
  return `${mm} ${hh} * * *`;
}

function makeDefaultStep(type) {
  switch (type) {
    case 'command': return { type: 'command', command: '' };
    case 'say': return { type: 'say', message: '' };
    case 'wait': return { type: 'wait', seconds: 60 };
    case 'power': return { type: 'power', action: 'restart' };
    case 'backup':
    default: return { type: 'backup' };
  }
}

function formatTriggerSummary(schedule, t) {
  if (schedule.trigger_type === 'interval') {
    return t('scheduler.trigger.intervalSummary', { minutes: schedule.interval_minutes });
  }
  if (schedule.trigger_type === 'event') {
    return t('scheduler.trigger.eventSummary', { event: t(`scheduler.events.${schedule.event}`) });
  }
  const shortcut = detectCronShortcut(schedule.cron);
  if (shortcut.mode === 'daily') {
    return `${t('scheduler.cron.daily')} ${shortcut.time}`;
  }
  if (shortcut.mode === 'weekly') {
    return `${t('scheduler.cron.weekly')} ${t(`scheduler.cron.days.${shortcut.day}`)} · ${shortcut.time}`;
  }
  return t('scheduler.trigger.cronSummary', { expr: schedule.cron });
}

function ScheduleFormModal({ open, initial, presets, onClose, onSave, busy }) {
  const { t } = useI18n();
  const baseId = useId();
  const isEdit = Boolean(initial && !initial._isNew && initial.id);

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [triggerType, setTriggerType] = useState('cron');
  const [cron, setCron] = useState('0 4 * * *');
  const [cronMode, setCronMode] = useState('daily');
  const [cronTime, setCronTime] = useState('04:00');
  const [cronDay, setCronDay] = useState('1');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [event, setEvent] = useState('server:started');
  const [onlyIfPlayers, setOnlyIfPlayers] = useState('any');
  const [steps, setSteps] = useState([{ type: 'say', message: '' }]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      const detected = detectCronShortcut(initial.cron || '0 4 * * *');
      setName(initial.name || '');
      setEnabled(initial.enabled !== undefined ? Boolean(initial.enabled) : true);
      setTriggerType(initial.trigger_type || 'cron');
      setCron(initial.cron || '0 4 * * *');
      setCronMode(detected.mode);
      setCronTime(detected.time);
      setCronDay(detected.day);
      setIntervalMinutes(initial.interval_minutes || 60);
      setEvent(initial.event || 'server:started');
      setOnlyIfPlayers(initial.only_if_players || 'any');
      setSteps(
        Array.isArray(initial.steps) && initial.steps.length > 0
          ? initial.steps.map(s => ({ ...s }))
          : [{ type: 'backup' }],
      );
    } else {
      setName('');
      setEnabled(true);
      setTriggerType('cron');
      setCron('0 4 * * *');
      setCronMode('daily');
      setCronTime('04:00');
      setCronDay('1');
      setIntervalMinutes(60);
      setEvent('server:started');
      setOnlyIfPlayers('any');
      setSteps([{ type: 'backup' }]);
    }
    setDirty(false);
  }, [open, initial]);

  function applyPreset(preset) {
    const detected = detectCronShortcut(preset.cron || '0 4 * * *');
    setName(preset.name);
    setTriggerType(preset.trigger_type || 'cron');
    setCron(preset.cron || '0 4 * * *');
    setCronMode(detected.mode);
    setCronTime(detected.time);
    setCronDay(detected.day);
    setOnlyIfPlayers(preset.only_if_players || 'any');
    setSteps((preset.steps || []).map(s => ({ ...s })));
    setDirty(true);
  }

  function handleCronModeChange(nextMode) {
    setCronMode(nextMode);
    if (nextMode !== 'custom') {
      setCron(buildCronFromShortcut(nextMode, cronTime, cronDay));
    }
    setDirty(true);
  }

  function handleCronTimeChange(nextTime) {
    setCronTime(nextTime);
    if (cronMode !== 'custom') {
      setCron(buildCronFromShortcut(cronMode, nextTime, cronDay));
    }
    setDirty(true);
  }

  function handleCronDayChange(nextDay) {
    setCronDay(nextDay);
    if (cronMode === 'weekly') {
      setCron(buildCronFromShortcut('weekly', cronTime, nextDay));
    }
    setDirty(true);
  }

  function addStep(type) {
    if (steps.length >= 20) return;
    setSteps(prev => [...prev, makeDefaultStep(type)]);
    setDirty(true);
  }

  function updateStep(index, patch) {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
    setDirty(true);
  }

  function moveStep(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    setSteps(prev => {
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
    setDirty(true);
  }

  function removeStep(index) {
    if (steps.length <= 1) return;
    setSteps(prev => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  function handleSubmit(e) {
    e.preventDefault();
    const payload = {
      name: name.trim(),
      enabled,
      trigger_type: triggerType,
      only_if_players: onlyIfPlayers,
      steps: steps.map(s => {
        if (s.type === 'wait') return { type: 'wait', seconds: Number(s.seconds) };
        if (s.type === 'command') return { type: 'command', command: String(s.command || '').trim() };
        if (s.type === 'say') return { type: 'say', message: String(s.message || '').trim() };
        if (s.type === 'power') return { type: 'power', action: s.action || 'restart' };
        return { type: 'backup' };
      }),
    };
    if (triggerType === 'cron') payload.cron = cron.trim();
    if (triggerType === 'interval') payload.interval_minutes = Number(intervalMinutes);
    if (triggerType === 'event') payload.event = event;

    onSave(payload);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? t('scheduler.edit') : t('scheduler.create')}
      icon={CalendarClock}
      size="lg"
      dirty={dirty}
    >
      <form onSubmit={handleSubmit} className="p-5 space-y-5">
        {!isEdit && presets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-line">
            <span className="text-xs text-fg-3 flex items-center gap-1.5 mr-1">
              <Sparkles size={13} strokeWidth={1.75} />
              {t('scheduler.form.applyPreset')} :
            </span>
            {presets.map(p => (
              <button
                key={p.id}
                type="button"
                className="btn-secondary !h-7 !px-2.5 !text-xs"
                onClick={() => applyPreset(p)}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-end">
          <div>
            <label htmlFor={`${baseId}-name`} className="label">{t('scheduler.form.name')}</label>
            <input
              id={`${baseId}-name`}
              className="input"
              value={name}
              onChange={e => { setName(e.target.value); setDirty(true); }}
              placeholder={t('scheduler.form.namePlaceholder')}
              maxLength={100}
              required
            />
          </div>
          <div className="flex items-center gap-2.5 h-9 px-3 rounded-lg border border-line bg-bg">
            <span className="text-[13px] text-fg-2">{t('scheduler.form.active')}</span>
            <Switch
              checked={enabled}
              onChange={val => { setEnabled(val); setDirty(true); }}
              label={t('scheduler.form.active')}
            />
          </div>
        </div>

        <div className="space-y-3">
          <span className="label mb-0">{t('scheduler.trigger.label')}</span>
          <Segmented
            value={triggerType}
            onChange={v => { setTriggerType(v); setDirty(true); }}
            items={[
              { id: 'cron', label: t('scheduler.trigger.cron') },
              { id: 'interval', label: t('scheduler.trigger.interval') },
              { id: 'event', label: t('scheduler.trigger.event') },
            ]}
          />

          {triggerType === 'cron' && (
            <div className="p-3.5 rounded-xl border border-line bg-bg space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-fg-2">{t('scheduler.cron.modeLabel')}</span>
                <Segmented
                  size="sm"
                  value={cronMode}
                  onChange={handleCronModeChange}
                  items={[
                    { id: 'daily', label: t('scheduler.cron.daily') },
                    { id: 'weekly', label: t('scheduler.cron.weekly') },
                    { id: 'custom', label: t('scheduler.cron.custom') },
                  ]}
                />
              </div>

              {cronMode === 'daily' && (
                <div>
                  <label htmlFor={`${baseId}-cron-time`} className="label">{t('scheduler.cron.time')}</label>
                  <input
                    id={`${baseId}-cron-time`}
                    type="time"
                    className="input w-40 font-mono"
                    value={cronTime}
                    onChange={e => handleCronTimeChange(e.target.value)}
                    required
                  />
                </div>
              )}

              {cronMode === 'weekly' && (
                <div className="flex flex-wrap gap-3">
                  <div className="flex-1 min-w-[160px]">
                    <label htmlFor={`${baseId}-cron-day`} className="label">{t('scheduler.cron.day')}</label>
                    <select
                      id={`${baseId}-cron-day`}
                      className="input"
                      value={cronDay}
                      onChange={e => handleCronDayChange(e.target.value)}
                    >
                      {['1', '2', '3', '4', '5', '6', '0'].map(d => (
                        <option key={d} value={d}>{t(`scheduler.cron.days.${d}`)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`${baseId}-cron-wtime`} className="label">{t('scheduler.cron.time')}</label>
                    <input
                      id={`${baseId}-cron-wtime`}
                      type="time"
                      className="input w-40 font-mono"
                      value={cronTime}
                      onChange={e => handleCronTimeChange(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              <div>
                <label htmlFor={`${baseId}-cron-expr`} className="label">{t('scheduler.cron.expression')}</label>
                <input
                  id={`${baseId}-cron-expr`}
                  className="input font-mono"
                  value={cron}
                  onChange={e => {
                    setCron(e.target.value);
                    setCronMode('custom');
                    setDirty(true);
                  }}
                  placeholder="0 4 * * *"
                  required
                />
                <p className="text-[11.5px] text-fg-3 mt-1">{t('scheduler.cron.hint')}</p>
              </div>
            </div>
          )}

          {triggerType === 'interval' && (
            <div className="p-3.5 rounded-xl border border-line bg-bg">
              <label htmlFor={`${baseId}-interval`} className="label">{t('scheduler.interval.minutes')}</label>
              <input
                id={`${baseId}-interval`}
                type="number"
                min={1}
                max={525600}
                className="input w-44 font-mono"
                value={intervalMinutes}
                onChange={e => { setIntervalMinutes(e.target.value); setDirty(true); }}
                required
              />
              <p className="text-[11.5px] text-fg-3 mt-1">{t('scheduler.interval.hint')}</p>
            </div>
          )}

          {triggerType === 'event' && (
            <div className="p-3.5 rounded-xl border border-line bg-bg">
              <label htmlFor={`${baseId}-event`} className="label">{t('scheduler.trigger.event')}</label>
              <select
                id={`${baseId}-event`}
                className="input"
                value={event}
                onChange={e => { setEvent(e.target.value); setDirty(true); }}
              >
                {EVENTS.map(ev => (
                  <option key={ev} value={ev}>{t(`scheduler.events.${ev}`)}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div>
          <label htmlFor={`${baseId}-cond`} className="label">{t('scheduler.condition.label')}</label>
          <select
            id={`${baseId}-cond`}
            className="input"
            value={onlyIfPlayers}
            onChange={e => { setOnlyIfPlayers(e.target.value); setDirty(true); }}
          >
            <option value="any">{t('scheduler.condition.any')}</option>
            <option value="online">{t('scheduler.condition.online')}</option>
            <option value="empty">{t('scheduler.condition.empty')}</option>
          </select>
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="label mb-0">{t('scheduler.form.steps')}</span>
            <span className="text-xs text-fg-3 font-mono">{steps.length}/20</span>
          </div>

          <ol className="space-y-2">
            {steps.map((step, idx) => {
              const StepIcon = STEP_ICONS[step.type] || Terminal;
              const fieldId = `${baseId}-step-${idx}`;
              return (
                <li
                  key={idx}
                  className="p-3 rounded-xl border border-line bg-bg flex flex-col sm:flex-row sm:items-center gap-2.5"
                >
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono text-fg-3 w-5 text-center">{idx + 1}.</span>
                    <div className="w-7 h-7 rounded-md flex items-center justify-center bg-surface-2 border border-line text-fg-2">
                      <StepIcon size={14} strokeWidth={1.75} />
                    </div>
                    <select
                      aria-label={t(`scheduler.stepTypes.${step.type}`)}
                      className="input !h-8 !w-auto text-xs"
                      value={step.type}
                      onChange={e => {
                        const next = makeDefaultStep(e.target.value);
                        setSteps(prev => prev.map((it, i) => (i === idx ? next : it)));
                        setDirty(true);
                      }}
                    >
                      {['say', 'command', 'wait', 'power', 'backup'].map(st => (
                        <option key={st} value={st}>{t(`scheduler.stepTypes.${st}`)}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex-1 min-w-0">
                    {step.type === 'command' && (
                      <>
                        <label htmlFor={fieldId} className="sr-only">{t('scheduler.stepFields.command')}</label>
                        <input
                          id={fieldId}
                          className="input !h-8 font-mono text-xs"
                          value={step.command || ''}
                          onChange={e => updateStep(idx, { command: e.target.value })}
                          placeholder={t('scheduler.stepFields.commandPlaceholder')}
                          maxLength={256}
                          required
                        />
                      </>
                    )}
                    {step.type === 'say' && (
                      <>
                        <label htmlFor={fieldId} className="sr-only">{t('scheduler.stepFields.message')}</label>
                        <input
                          id={fieldId}
                          className="input !h-8 text-xs"
                          value={step.message || ''}
                          onChange={e => updateStep(idx, { message: e.target.value })}
                          placeholder={t('scheduler.stepFields.messagePlaceholder')}
                          maxLength={256}
                          required
                        />
                      </>
                    )}
                    {step.type === 'wait' && (
                      <div className="flex items-center gap-2">
                        <label htmlFor={fieldId} className="text-xs text-fg-2 shrink-0">
                          {t('scheduler.stepFields.seconds')}
                        </label>
                        <input
                          id={fieldId}
                          type="number"
                          min={1}
                          max={3600}
                          className="input !h-8 w-28 font-mono text-xs"
                          value={step.seconds ?? 60}
                          onChange={e => updateStep(idx, { seconds: e.target.value })}
                          required
                        />
                      </div>
                    )}
                    {step.type === 'power' && (
                      <>
                        <label htmlFor={fieldId} className="sr-only">{t('scheduler.stepFields.action')}</label>
                        <select
                          id={fieldId}
                          className="input !h-8 text-xs"
                          value={step.action || 'restart'}
                          onChange={e => updateStep(idx, { action: e.target.value })}
                        >
                          <option value="start">{t('scheduler.stepFields.powerStart')}</option>
                          <option value="stop">{t('scheduler.stepFields.powerStop')}</option>
                          <option value="restart">{t('scheduler.stepFields.powerRestart')}</option>
                        </select>
                      </>
                    )}
                    {step.type === 'backup' && (
                      <p className="text-xs text-fg-3">{t('scheduler.stepFields.backupNote')}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0 self-end sm:self-center">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => moveStep(idx, -1)}
                      disabled={idx === 0}
                      aria-label={t('scheduler.form.moveUp')}
                      title={t('scheduler.form.moveUp')}
                    >
                      <ArrowUp size={13} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => moveStep(idx, 1)}
                      disabled={idx === steps.length - 1}
                      aria-label={t('scheduler.form.moveDown')}
                      title={t('scheduler.form.moveDown')}
                    >
                      <ArrowDown size={13} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn hover:!text-danger"
                      onClick={() => removeStep(idx)}
                      disabled={steps.length <= 1}
                      aria-label={t('scheduler.form.removeStep')}
                      title={t('scheduler.form.removeStep')}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-xs text-fg-3 mr-1">{t('scheduler.form.addStep')} :</span>
            {['say', 'command', 'wait', 'power', 'backup'].map(st => {
              const Icon = STEP_ICONS[st];
              return (
                <button
                  key={st}
                  type="button"
                  className="btn-secondary !h-7 !px-2.5 !text-xs"
                  disabled={steps.length >= 20}
                  onClick={() => addStep(st)}
                >
                  <Icon size={12} strokeWidth={1.75} />
                  {t(`scheduler.stepTypes.${st}`)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('scheduler.form.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t('scheduler.form.saving') : t('scheduler.form.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RunsModal({ serverId, schedule, onClose }) {
  const { t } = useI18n();
  const locale = useDateLocale();

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['schedule-runs', serverId, schedule?.id],
    queryFn: () => getScheduleRuns(serverId, schedule.id),
    enabled: Boolean(schedule?.id),
  });

  return (
    <Modal
      open={Boolean(schedule)}
      onClose={onClose}
      title={schedule ? t('scheduler.runs.title', { name: schedule.name }) : ''}
      icon={History}
      size="md"
    >
      <div className="p-5 space-y-3">
        {isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-14" />)}</div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-fg-2 text-center py-8">{t('scheduler.runs.empty')}</p>
        ) : (
          <ol className="space-y-2">
            {runs.map(run => {
              const st = STATUS_STYLE[run.status] || STATUS_STYLE.skipped;
              const Icon = st.icon;
              const started = parseDbDate(run.started_at);
              const finished = parseDbDate(run.finished_at);
              const durationSec = started && finished
                ? Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000))
                : null;
              return (
                <li key={run.id} className="p-3 rounded-xl border border-line bg-bg flex items-start gap-3">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: `rgba(${st.rgb}, 0.1)`, color: st.color }}
                  >
                    <Icon size={15} strokeWidth={1.75} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-semibold" style={{ color: st.color }}>
                        {t(`scheduler.status.${run.status}`)}
                      </span>
                      <span className="text-xs text-fg-3 font-mono">
                        {started ? format(started, 'dd/MM/yyyy HH:mm:ss', { locale }) : '—'}
                        {durationSec !== null ? ` · ${t('scheduler.runs.duration', { seconds: durationSec })}` : ''}
                      </span>
                    </div>
                    {run.message && (
                      <p className="text-xs text-fg-2 mt-1 break-words">{run.message}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex justify-end pt-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('scheduler.runs.close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function SchedulerTab({ server }) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const locale = useDateLocale();
  const qKey = ['schedules', server.id];

  const [editing, setEditing] = useState(null); // null | { isNew: true, preset? } | schedule
  const [historyFor, setHistoryFor] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [runningId, setRunningId] = useState(null);

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => getSchedules(server.id),
    refetchInterval: 15000,
  });

  const { data: presetsData } = useQuery({
    queryKey: ['schedule-presets'],
    queryFn: getSchedulePresets,
    retry: false,
  });
  const presets = Array.isArray(presetsData) && presetsData.length > 0 ? presetsData : FALLBACK_PRESETS;

  const saveMut = useMutation({
    mutationFn: (payload) => (
      editing && !editing._isNew && editing.id
        ? updateSchedule(server.id, editing.id, payload)
        : createSchedule(server.id, payload)
    ),
    onSuccess: () => {
      const wasEdit = Boolean(editing && !editing._isNew && editing.id);
      setEditing(null);
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(wasEdit ? t('scheduler.toast.updated') : t('scheduler.toast.created'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('scheduler.toast.error')),
  });

  const toggleMut = useMutation({
    mutationFn: ({ sid, enabled }) => updateSchedule(server.id, sid, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qKey }),
    onError: (err) => toast.error(err.response?.data?.error || t('scheduler.toast.error')),
  });

  const deleteMut = useMutation({
    mutationFn: (sid) => deleteSchedule(server.id, sid),
    onSuccess: () => {
      setToDelete(null);
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('scheduler.toast.deleted'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('scheduler.toast.error')),
  });

  const runMut = useMutation({
    mutationFn: (sid) => {
      setRunningId(sid);
      return runSchedule(server.id, sid);
    },
    onSuccess: (run, sid) => {
      qc.invalidateQueries({ queryKey: qKey });
      qc.invalidateQueries({ queryKey: ['schedule-runs', server.id, sid] });
      if (run?.status === 'failed') {
        toast.error(t('scheduler.toast.runFailed', { error: run.message || '' }));
      } else if (run?.status === 'running') {
        toast(t('scheduler.toast.runStarted'));
      } else if (run?.status === 'skipped') {
        toast(t('scheduler.toast.runSkipped', { reason: run.message || '' }));
      } else {
        toast.success(t('scheduler.toast.runSuccess'));
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || t('scheduler.toast.error')),
    onSettled: () => setRunningId(null),
  });

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-fg">{t('scheduler.title')}</h3>
          <p className="text-xs text-fg-2 mt-1">
            {t('scheduler.subtitle', { count: schedules.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {presets.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setEditing({ ...presets[0], id: undefined, _isNew: true })}
            >
              <Sparkles size={14} strokeWidth={1.75} />
              {presets[0].name}
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={() => setEditing({ _isNew: true })}
          >
            <Plus size={14} strokeWidth={2.25} />
            {t('scheduler.create')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-[84px]" />)}</div>
      ) : schedules.length === 0 ? (
        <div className="card text-center py-14">
          <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center bg-surface-2 border border-line">
            <CalendarClock size={20} strokeWidth={1.5} className="text-fg-3" />
          </div>
          <p className="text-sm font-medium text-fg mt-4">{t('scheduler.emptyTitle')}</p>
          <p className="text-xs text-fg-2 mt-1 max-w-md mx-auto">{t('scheduler.emptyBody')}</p>
        </div>
      ) : (
        <ol className="space-y-2.5">
          {schedules.map((s, idx) => {
            const nextDate = parseDbDate(s.next_run_at);
            const lastDate = parseDbDate(s.last_run_at);
            const statusMeta = s.last_status ? STATUS_STYLE[s.last_status] : null;
            const StatusIcon = statusMeta?.icon;
            const isRunningThis = runningId === s.id;

            return (
              <li
                key={s.id}
                className="card card-interactive card-in flex flex-col sm:flex-row sm:items-center gap-4 !py-3.5 !px-4"
                style={{ animationDelay: `${Math.min(idx, 10) * 25}ms` }}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Switch
                    checked={Boolean(s.enabled)}
                    onChange={checked => toggleMut.mutate({ sid: s.id, enabled: checked })}
                    label={s.enabled ? t('scheduler.disable') : t('scheduler.enable')}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-fg truncate">{s.name}</span>
                      <span className="badge bg-surface-2 border border-line text-fg-2">
                        {t('scheduler.stepsCount', { count: s.steps?.length || 0 })}
                      </span>
                      {s.only_if_players !== 'any' && (
                        <span className="badge bg-surface-2 border border-line text-fg-3">
                          {t(`scheduler.condition.${s.only_if_players}`)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-fg-2 mt-1 flex-wrap">
                      <span>{formatTriggerSummary(s, t)}</span>
                      <span className="text-fg-3">·</span>
                      <span className="text-fg-3">
                        {t('scheduler.nextRun')} :{' '}
                        <span className="text-fg-2">
                          {!s.enabled
                            ? t('scheduler.paused')
                            : s.trigger_type === 'event'
                              ? t('scheduler.noNextRun')
                              : nextDate
                                ? `${format(nextDate, 'dd/MM HH:mm', { locale })} (${formatDistanceToNow(nextDate, { addSuffix: true, locale })})`
                                : '—'}
                        </span>
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs mt-1 flex-wrap">
                      {statusMeta && StatusIcon ? (
                        <span className="inline-flex items-center gap-1" style={{ color: statusMeta.color }}>
                          <StatusIcon size={12} strokeWidth={2} />
                          {t(`scheduler.status.${s.last_status}`)}
                          {lastDate && (
                            <span className="text-fg-3 font-normal ml-0.5">
                              ({formatDistanceToNow(lastDate, { addSuffix: true, locale })})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-fg-3">{t('scheduler.neverRun')}</span>
                      )}
                      {s.last_status === 'failed' && s.last_error && (
                        <span className="text-danger truncate max-w-md" title={s.last_error}>
                          — {s.last_error}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                  <button
                    type="button"
                    className="btn-secondary !h-8 !px-2.5 !text-xs"
                    disabled={isRunningThis}
                    onClick={() => runMut.mutate(s.id)}
                  >
                    <Play size={12} strokeWidth={2} />
                    {isRunningThis ? t('scheduler.running') : t('scheduler.runNow')}
                  </button>
                  <button
                    type="button"
                    className="icon-btn !w-8 !h-8"
                    onClick={() => setHistoryFor(s)}
                    title={t('scheduler.history')}
                    aria-label={t('scheduler.history')}
                  >
                    <History size={14} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn !w-8 !h-8"
                    onClick={() => setEditing(s)}
                    title={t('scheduler.editAction')}
                    aria-label={t('scheduler.editAction')}
                  >
                    <Pencil size={14} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    className="btn-danger !h-8 !px-2"
                    onClick={() => setToDelete(s)}
                    title={t('scheduler.deleteAction')}
                    aria-label={t('scheduler.deleteAction')}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <ScheduleFormModal
        open={editing !== null}
        initial={editing}
        presets={presets}
        onClose={() => setEditing(null)}
        onSave={payload => saveMut.mutate(payload)}
        busy={saveMut.isPending}
      />

      <RunsModal
        serverId={server.id}
        schedule={historyFor}
        onClose={() => setHistoryFor(null)}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => deleteMut.mutate(toDelete.id)}
        busy={deleteMut.isPending}
        title={t('scheduler.confirmDeleteTitle')}
        message={toDelete ? t('scheduler.confirmDeleteBody', { name: toDelete.name }) : ''}
        confirmLabel={t('scheduler.deleteAction')}
      />
    </div>
  );
}
