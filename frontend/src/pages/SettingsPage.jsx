import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Moon, Sun, Monitor } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { getSources, updateSource, changePassword, getAppSettings, patchAppSettings, testNotification } from '../services/api';
import { useI18n } from '../i18n';
import { useThemeStore, useAuthStore } from '../store';
import ApiSourceList from '../components/settings/ApiSourceList';
import { getSocket } from '../hooks/useSocket';
import PageHeader, { Page } from '../components/layout/PageHeader';
import Switch from '../components/ui/Switch';

// Aperçu miniature d'un thème (couleurs figées : c'est une vignette)
const PREVIEW = {
  dark:  { bg: '#0A0A0A', side: '#0F0F0F', card: '#141414', line: '#262626', fg: '#EDEDED' },
  light: { bg: '#FAFAFA', side: '#FFFFFF', card: '#FFFFFF', line: '#E5E5E5', fg: '#0A0A0A' },
};

function Mini({ p }) {
  return (
    <div className="flex h-full" style={{ background: p.bg }}>
      <div className="w-1/4 h-full p-1.5 space-y-1" style={{ background: p.side, borderRight: `1px solid ${p.line}` }}>
        <div className="h-1.5 rounded-sm w-3/4" style={{ background: p.fg, opacity: 0.8 }} />
        <div className="h-1 rounded-sm w-2/3" style={{ background: p.fg, opacity: 0.25 }} />
        <div className="h-1 rounded-sm w-1/2" style={{ background: p.fg, opacity: 0.25 }} />
      </div>
      <div className="flex-1 p-2 space-y-1.5">
        <div className="h-1.5 rounded-sm w-1/3" style={{ background: p.fg, opacity: 0.8 }} />
        <div className="h-6 rounded" style={{ background: p.card, border: `1px solid ${p.line}` }} />
        <div className="h-3 rounded" style={{ background: p.card, border: `1px solid ${p.line}` }} />
      </div>
    </div>
  );
}

function ThemePicker() {
  const { t } = useI18n();
  const { theme, setTheme, colorblind, setColorblind } = useThemeStore();
  const options = [
    { id: 'dark', label: t('settings.themeDark'), Icon: Moon },
    { id: 'light', label: t('settings.themeLight'), Icon: Sun },
    { id: 'system', label: t('settings.themeSystem'), Icon: Monitor },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {options.map(({ id, label, Icon }) => {
          const active = theme === id;
          return (
            <button
              key={id}
              onClick={() => setTheme(id)}
              aria-pressed={active}
              className={clsx(
                'rounded-xl overflow-hidden text-left border transition-colors',
                active ? 'border-fg ring-1 ring-fg' : 'border-line-strong hover:border-fg-3',
              )}
            >
              <div className="h-20 relative">
                {id === 'system' ? (
                  <div className="flex h-full">
                    <div className="w-1/2 overflow-hidden"><div className="w-[200%] h-full"><Mini p={PREVIEW.dark} /></div></div>
                    <div className="w-1/2 overflow-hidden relative"><div className="w-[200%] h-full -ml-[100%]"><Mini p={PREVIEW.light} /></div></div>
                  </div>
                ) : <Mini p={PREVIEW[id]} />}
              </div>
              <div className="flex items-center gap-2 px-3 h-10 border-t border-line bg-surface">
                <Icon size={14} strokeWidth={1.75} className="text-fg-2" />
                <span className="text-[13px] font-medium text-fg flex-1">{label}</span>
                {active && <Check size={14} strokeWidth={2.25} className="text-fg" />}
              </div>
            </button>
          );
        })}
      </div>
      <label className="flex items-center justify-between gap-4 card !py-3.5 cursor-pointer">
        <span>
          <span className="block text-[13.5px] font-medium text-fg">{t('settings.colorblind')}</span>
          <span className="block text-[12.5px] text-fg-2 mt-0.5">{t('settings.colorblindHint')}</span>
        </span>
        <Switch checked={colorblind} onChange={setColorblind} label={t('settings.colorblind')} />
      </label>
    </div>
  );
}

/** Section de réglages : titre + description à gauche, contenu à droite. */
function Section({ title, description, children }) {
  return (
    <section className="grid md:grid-cols-[240px_minmax(0,1fr)] gap-x-10 gap-y-4 py-8 border-t border-line first:border-t-0 first:pt-0">
      <div>
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        {description && <p className="text-[12.5px] text-fg-2 mt-1 leading-relaxed">{description}</p>}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

function ApiKeyField({ sourceId, label, description, configured }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const { t } = useI18n();

  const save = useMutation({
    mutationFn: () => updateSource(sourceId, { api_key: value }),
    onSuccess: () => {
      setValue('');
      toast.success(t('settings.saveSuccess'));
      qc.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: () => toast.error(t('settings.saveError')),
  });

  return (
    <form className="card space-y-3" onSubmit={e => { e.preventDefault(); if (value) save.mutate(); }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-fg">{label}</p>
          <p className="text-[12.5px] text-fg-2 mt-0.5">{description}</p>
        </div>
        {configured && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-2 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-success" /> {t('settings.keyConfigured')}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          className="input flex-1"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={configured ? '••••••••••••••••' : t('settings.enterKey')}
          autoComplete="off"
        />
        <button type="submit" className="btn-primary shrink-0" disabled={!value || save.isPending}>
          {save.isPending ? t('settings.saving') : t('settings.save')}
        </button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const { t } = useI18n();
  const setToken = useAuthStore(s => s.setToken);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(e) {
    e.preventDefault();
    if (mismatch || next.length < 8) return;
    setSaving(true);
    try {
      const r = await changePassword(current, next);
      setToken(r.token); // les autres sessions sont déconnectées, celle-ci continue
      getSocket().auth = { token: r.token }; // reconnexions du temps réel avec le nouveau jeton
      setCurrent(''); setNext(''); setConfirm('');
      toast.success(t('settings.passwordChanged'));
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card space-y-3" onSubmit={submit}>
      <div>
        <label className="label">{t('settings.currentPassword')}</label>
        <input type="password" className="input" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="label">{t('settings.newPassword')}</label>
          <input type="password" className="input" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
        </div>
        <div>
          <label className="label">{t('settings.confirmPassword')}</label>
          <input type="password" className="input" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required />
        </div>
      </div>
      {mismatch && <p className="text-[12px] text-danger">{t('setup.passwordMismatch')}</p>}
      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-[12px] text-fg-3">{t('settings.passwordHint')}</p>
        <button type="submit" className="btn-primary shrink-0" disabled={saving || mismatch || !current || next.length < 8}>
          {saving ? t('settings.saving') : t('settings.changePassword')}
        </button>
      </div>
    </form>
  );
}

function NotificationsForm() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['app-settings'], queryFn: getAppSettings, staleTime: 30000 });
  const [url, setUrl] = useState(null);
  const value = url ?? data?.notify_webhook_url ?? '';
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const dirty = url !== null && url !== (data?.notify_webhook_url ?? '');

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await patchAppSettings({ notify_webhook_url: value.trim() });
      setUrl(null);
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      toast.success(t('settings.saveSuccess'));
    } catch (err) {
      toast.error(err.response?.data?.error || t('settings.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try { await testNotification(); toast.success(t('settings.notifyTestSent')); }
    catch (err) { toast.error(err.response?.data?.error || t('common.error')); }
    finally { setTesting(false); }
  }

  return (
    <form className="card space-y-3" onSubmit={save}>
      <div>
        <label className="label">{t('settings.webhookUrl')}</label>
        <input
          className="input font-mono text-[12.5px]"
          value={value}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/…"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-[12px] text-fg-3 mt-1.5">{t('settings.webhookHint')}</p>
        {data?.notify_env_configured && !value && <p className="text-[12px] text-fg-2 mt-1">{t('settings.webhookFromEnv')}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={test} disabled={testing || dirty || (!value && !data?.notify_env_configured)}>
          {testing ? '…' : t('settings.notifyTest')}
        </button>
        <button type="submit" className="btn-primary" disabled={!dirty || saving}>
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const { t } = useI18n();
  const { data: sources = [] } = useQuery({ queryKey: ['sources'], queryFn: getSources, staleTime: 30000 });
  const hasKey = (id) => !!sources.find(s => s.id === id)?.has_api_key;

  return (
    <Page>
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />

      <div>
        <Section title={t('settings.theme')} description={t('settings.themeHint')}>
          <ThemePicker />
        </Section>

        <Section title={t('settings.apiKeys')} description={t('settings.apiKeysHint')}>
          <ApiKeyField
            sourceId="curseforge"
            label="CurseForge"
            description={t('settings.curseforgeDesc')}
            configured={hasKey('curseforge')}
          />
          <ApiKeyField
            sourceId="modrinth"
            label={t('settings.modrinthOptional')}
            description={t('settings.modrinthDesc')}
            configured={hasKey('modrinth')}
          />
        </Section>

        <Section title={t('settings.notifications')} description={t('settings.notificationsHint')}>
          <NotificationsForm />
        </Section>

        <Section title={t('settings.account')} description={t('settings.accountHint')}>
          <PasswordForm />
        </Section>

        <Section title={t('settings.apiSources')}>
          <ApiSourceList />
        </Section>

        <Section title={t('settings.system')}>
          <div className="card !p-0 divide-y divide-line text-[13px]">
            {[
              ['Backend', 'Node.js 24 + Express'],
              ['Image Minecraft', 'itzg/minecraft-server'],
              ['Database', 'SQLite'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between px-4 h-11 items-center">
                <span className="text-fg-2">{k}</span>
                <span className="text-fg font-mono text-[12px]">{v}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </Page>
  );
}
