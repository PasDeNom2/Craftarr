import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getWhitelist, addToWhitelist, removeFromWhitelist, patchServer } from '../../services/api';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import { UserPlus, Trash2, ShieldCheck, ShieldOff } from 'lucide-react';
import Switch from '../ui/Switch';

export default function WhitelistPanel({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [togglingWhitelist, setTogglingWhitelist] = useState(false);

  const { data: list = [], isLoading } = useQuery({
    queryKey: ['whitelist', server.id],
    queryFn: () => getWhitelist(server.id),
    staleTime: 30000,
  });

  async function handleToggle() {
    setTogglingWhitelist(true);
    try {
      await patchServer(server.id, { whitelist_enabled: !server.whitelist_enabled });
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      toast.success(server.whitelist_enabled ? t('whitelist.disabled') : t('whitelist.enabled'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setTogglingWhitelist(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!username.trim()) return;
    setAdding(true);
    try {
      await addToWhitelist(server.id, username.trim());
      qc.invalidateQueries({ queryKey: ['whitelist', server.id] });
      setUsername('');
      toast.success(t('whitelist.added', { name: username.trim() }));
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(name) {
    try {
      await removeFromWhitelist(server.id, name);
      qc.invalidateQueries({ queryKey: ['whitelist', server.id] });
      toast.success(t('whitelist.removed', { name }));
    } catch {
      toast.error(t('common.error'));
    }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Toggle */}
      <div className="card flex items-center justify-between gap-4 !py-3.5 !px-4">
        <div className="flex items-center gap-3">
          {server.whitelist_enabled
            ? <ShieldCheck size={18} strokeWidth={1.5} style={{ color: 'var(--success)' }} />
            : <ShieldOff size={18} strokeWidth={1.5} className="text-fg-2" />
          }
          <div>
            <p className="text-sm font-medium text-fg">{t('whitelist.toggle')}</p>
            <p className="text-[11px] text-fg-3 mt-0.5">
              {server.whitelist_enabled ? t('whitelist.toggleOnDesc') : t('whitelist.toggleOffDesc')}
            </p>
          </div>
        </div>
        <Switch checked={!!server.whitelist_enabled} onChange={handleToggle} disabled={togglingWhitelist} label={t('whitelist.toggle')} />
      </div>

      {/* Add player */}
      <form onSubmit={handleAdd} className="flex gap-2 items-center">
        <input
          className="input flex-1"
          placeholder={t('whitelist.addPlaceholder')}
          value={username}
          onChange={e => setUsername(e.target.value)}
          disabled={adding}
        />
        <button
          type="submit"
          className="btn-primary !h-10 shrink-0"
          disabled={adding || !username.trim()}
        >
          <UserPlus size={14} strokeWidth={1.5} />
          {adding ? t('common.loading') : t('whitelist.add')}
        </button>
      </form>

      {/* List */}
      <div className="card !p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-fg-3">{t('common.loading')}</div>
        ) : list.length === 0 ? (
          <div className="p-6 text-center text-sm text-fg-3">{t('whitelist.empty')}</div>
        ) : (
          <ul className="divide-y divide-tint/[0.06] stagger-fast">
            {list.map(player => (
              <li key={player.name} className="group flex items-center justify-between px-4 py-3 hover:bg-tint/[0.03] transition-colors">
                <div className="flex items-center gap-3">
                  <img
                    src={`https://mc-heads.net/avatar/${player.name}/64`}
                    alt={player.name}
                    width={32} height={32}
                    className="rounded-lg"
                    style={{ imageRendering: 'pixelated' }}
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                  <div className="min-w-0">
                    <p className="text-[14px] text-fg font-medium">{player.name}</p>
                    <p className="text-[10.5px] text-fg-3 font-mono truncate">{player.uuid}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(player.name)}
                  className="icon-btn !h-8 !min-w-8 hover:!text-danger opacity-60 group-hover:opacity-100"
                  title={t('whitelist.remove')}
                >
                  <Trash2 size={13} strokeWidth={1.5} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
