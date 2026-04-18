import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getWhitelist, addToWhitelist, removeFromWhitelist, patchServer } from '../../services/api';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import { UserPlus, Trash2, ShieldCheck, ShieldOff } from 'lucide-react';

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
    <div className="space-y-5">
      {/* Toggle */}
      <div
        className="flex items-center justify-between p-4 rounded-xl"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-3">
          {server.whitelist_enabled
            ? <ShieldCheck size={18} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
            : <ShieldOff size={18} strokeWidth={1.5} className="text-[#6B6B76]" />
          }
          <div>
            <p className="text-sm font-medium text-[#F0F0F0]">{t('whitelist.toggle')}</p>
            <p className="text-[11px] text-[#4A4A55] mt-0.5">
              {server.whitelist_enabled ? t('whitelist.toggleOnDesc') : t('whitelist.toggleOffDesc')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          disabled={togglingWhitelist}
          className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50"
          style={{ background: server.whitelist_enabled ? 'var(--accent)' : 'rgba(255,255,255,0.1)' }}
        >
          <span
            className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200"
            style={{ transform: server.whitelist_enabled ? 'translateX(24px)' : 'translateX(4px)' }}
          />
        </button>
      </div>

      {/* Add player */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          className="input flex-1"
          placeholder={t('whitelist.addPlaceholder')}
          value={username}
          onChange={e => setUsername(e.target.value)}
          disabled={adding}
        />
        <button
          type="submit"
          className="btn-primary px-4 py-2 gap-2 shrink-0"
          disabled={adding || !username.trim()}
        >
          <UserPlus size={14} strokeWidth={1.5} />
          {adding ? t('common.loading') : t('whitelist.add')}
        </button>
      </form>

      {/* List */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {isLoading ? (
          <div className="p-6 text-center text-sm text-[#4A4A55]">{t('common.loading')}</div>
        ) : list.length === 0 ? (
          <div className="p-6 text-center text-sm text-[#4A4A55]">{t('whitelist.empty')}</div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
            {list.map(player => (
              <li key={player.name} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center gap-3">
                  <img
                    src={`https://mc-heads.net/avatar/${player.name}/24`}
                    alt={player.name}
                    width={24} height={24}
                    className="rounded"
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                  <span className="text-sm text-[#F0F0F0] font-medium">{player.name}</span>
                  <span className="text-[10px] text-[#4A4A55] font-mono">{player.uuid}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(player.name)}
                  className="p-1.5 rounded-lg text-[#4A4A55] hover:text-[#F87171] hover:bg-white/[0.04] transition-colors"
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
