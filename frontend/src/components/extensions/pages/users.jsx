import React, { useId, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Users, Plus, KeyRound, Trash2, Shield } from 'lucide-react';
import { getServers } from '../../../services/api';
import {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  setUserServerPermissions,
} from '../../../services/features/accounts';
import { useAuthStore } from '../../../store';
import { useI18n } from '../../../i18n';
import { parseDbDate } from '../../../utils/dates';
import PageHeader, { Page } from '../../layout/PageHeader';
import Modal from '../../ui/Modal';
import ConfirmDialog from '../../ui/ConfirmDialog';
import Switch from '../../ui/Switch';

export const page = {
  path: 'users',
  navKey: 'accounts.nav',
  Icon: Users,
  order: 10,
  adminOnly: true,
};

const PERM_KEYS = ['view', 'console', 'power', 'files', 'players', 'backups', 'manage'];

export default function UsersPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const currentUser = useAuthStore(s => s.user);
  const formId = useId();

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');

  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');

  const [deleteTarget, setDeleteTarget] = useState(null);

  const [permsTarget, setPermsTarget] = useState(null);
  const [permsDraft, setPermsDraft] = useState({});

  const isAdmin = currentUser?.role === 'admin';

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: getUsers,
    enabled: isAdmin,
  });

  const { data: servers = [] } = useQuery({
    queryKey: ['servers'],
    queryFn: getServers,
    enabled: isAdmin,
  });

  const createMut = useMutation({
    mutationFn: () => createUser({ username: newUsername.trim(), password: newPassword, role: newRole }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('accounts.users.createdToast'));
      setCreateOpen(false);
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const updateMut = useMutation({
    mutationFn: ({ uid, payload }) => updateUser(uid, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      if (vars.payload.password) {
        toast.success(t('accounts.users.resetToast'));
        setResetTarget(null);
        setResetPassword('');
      } else {
        toast.success(t('accounts.users.updatedToast'));
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const deleteMut = useMutation({
    mutationFn: (uid) => deleteUser(uid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('accounts.users.deletedToast'));
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const savePermsMut = useMutation({
    mutationFn: async () => {
      const existing = permsTarget.permissions || {};
      const calls = [];
      for (const srv of servers) {
        const next = (permsDraft[srv.id] || []).slice().sort();
        const prev = (existing[srv.id] || []).slice().sort();
        if (JSON.stringify(next) !== JSON.stringify(prev)) {
          calls.push(setUserServerPermissions(permsTarget.id, srv.id, next));
        }
      }
      await Promise.all(calls);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('accounts.users.permsSavedToast'));
      setPermsTarget(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  if (currentUser && currentUser.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  if (!currentUser) {
    return null;
  }

  function openPermsModal(u) {
    const initial = {};
    for (const srv of servers) {
      initial[srv.id] = [...(u.permissions?.[srv.id] || [])];
    }
    setPermsDraft(initial);
    setPermsTarget(u);
  }

  function togglePerm(serverId, perm) {
    setPermsDraft(prev => {
      const cur = new Set(prev[serverId] || []);
      if (cur.has(perm)) {
        cur.delete(perm);
        if (perm === 'view') cur.clear();
      } else {
        cur.add(perm);
        if (perm !== 'view') cur.add('view');
      }
      return { ...prev, [serverId]: PERM_KEYS.filter(k => cur.has(k)) };
    });
  }

  function formatDate(raw) {
    const d = parseDbDate(raw);
    if (!d) return t('accounts.users.never');
    return d.toLocaleString(locale === 'en' ? 'en-US' : 'fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  return (
    <Page>
      <PageHeader
        title={t('accounts.users.title')}
        description={t('accounts.users.subtitle')}
        actions={(
          <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={15} strokeWidth={2} /> {t('accounts.users.newUser')}
          </button>
        )}
      />

      <div className="card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-fg-3 uppercase tracking-wider">
                <th className="py-3 px-4 font-medium">{t('accounts.users.username')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.users.role')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.users.status')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.users.twoFactor')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.users.permissions')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.users.lastLogin')}</th>
                <th className="py-3 px-4 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-fg-3">…</td>
                </tr>
              ) : users.map(u => {
                const isSelf = u.id === currentUser.id;
                const serverCount = Object.keys(u.permissions || {}).length;
                return (
                  <tr key={u.id} className="hover:bg-surface-2/60 transition-colors">
                    <td className="py-3 px-4 font-medium text-fg">{u.username}</td>
                    <td className="py-3 px-4">
                      <select
                        className="input !py-1 !px-2 !text-[13px] w-auto"
                        value={u.role}
                        disabled={isSelf || updateMut.isPending}
                        aria-label={`${t('accounts.users.role')} ${u.username}`}
                        onChange={e => updateMut.mutate({ uid: u.id, payload: { role: e.target.value } })}
                      >
                        <option value="admin">{t('accounts.roles.admin')}</option>
                        <option value="user">{t('accounts.roles.user')}</option>
                      </select>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={!u.disabled}
                          disabled={isSelf || updateMut.isPending}
                          label={`${t('accounts.users.toggleDisable')} ${u.username}`}
                          onChange={(active) => updateMut.mutate({ uid: u.id, payload: { disabled: !active } })}
                        />
                        <span className={u.disabled ? 'text-fg-3 text-[12px]' : 'text-fg-2 text-[12px]'}>
                          {u.disabled ? t('accounts.users.disabled') : t('accounts.users.active')}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className={u.totp_enabled ? 'badge bg-success/15 text-success' : 'badge text-fg-3'}>
                        {u.totp_enabled ? t('accounts.users.enabled2fa') : t('accounts.users.disabled2fa')}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {u.role === 'admin' ? (
                        <span className="text-[12px] text-fg-3">{t('accounts.roles.admin')}</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary !py-1 !px-2.5 !text-[12.5px]"
                          onClick={() => openPermsModal(u)}
                        >
                          <Shield size={13} /> {t('accounts.users.serversCount', { count: serverCount })}
                        </button>
                      )}
                    </td>
                    <td className="py-3 px-4 text-fg-3 text-[12.5px] whitespace-nowrap">
                      {formatDate(u.last_login_at)}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          className="btn-ghost !py-1 !px-2 !text-[12.5px]"
                          onClick={() => { setResetTarget(u); setResetPassword(''); }}
                          title={t('accounts.users.resetPassword')}
                          aria-label={`${t('accounts.users.resetPassword')} ${u.username}`}
                        >
                          <KeyRound size={14} /> {t('accounts.users.resetPassword')}
                        </button>
                        <button
                          type="button"
                          className="icon-btn text-danger hover:bg-danger/10 disabled:opacity-35"
                          disabled={isSelf}
                          onClick={() => setDeleteTarget(u)}
                          title={t('accounts.users.delete')}
                          aria-label={`${t('accounts.users.delete')} ${u.username}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Création d'utilisateur */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('accounts.users.createTitle')}
        size="sm"
      >
        <form
          onSubmit={e => { e.preventDefault(); createMut.mutate(); }}
          className="p-5 space-y-4"
        >
          <div>
            <label htmlFor={`${formId}-new-user`} className="label">{t('accounts.users.username')}</label>
            <input
              id={`${formId}-new-user`}
              className="input"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              minLength={3}
              maxLength={64}
              required
              autoFocus
            />
          </div>
          <div>
            <label htmlFor={`${formId}-new-pass`} className="label">{t('accounts.users.password')}</label>
            <input
              id={`${formId}-new-pass`}
              type="password"
              className="input"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <div>
            <label htmlFor={`${formId}-new-role`} className="label">{t('accounts.users.role')}</label>
            <select
              id={`${formId}-new-role`}
              className="input"
              value={newRole}
              onChange={e => setNewRole(e.target.value)}
            >
              <option value="user">{t('accounts.roles.user')}</option>
              <option value="admin">{t('accounts.roles.admin')}</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={createMut.isPending}>
              {t('accounts.users.createSubmit')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Réinitialisation du mot de passe */}
      <Modal
        open={!!resetTarget}
        onClose={() => setResetTarget(null)}
        title={resetTarget ? t('accounts.users.resetTitle', { name: resetTarget.username }) : ''}
        size="sm"
      >
        <form
          onSubmit={e => {
            e.preventDefault();
            updateMut.mutate({ uid: resetTarget.id, payload: { password: resetPassword } });
          }}
          className="p-5 space-y-4"
        >
          <p className="text-[13px] text-fg-2">{t('accounts.users.resetHint')}</p>
          <div>
            <label htmlFor={`${formId}-reset-pass`} className="label">{t('accounts.users.newPassword')}</label>
            <input
              id={`${formId}-reset-pass`}
              type="password"
              className="input"
              value={resetPassword}
              onChange={e => setResetPassword(e.target.value)}
              minLength={8}
              required
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setResetTarget(null)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={updateMut.isPending}>
              {t('accounts.users.resetSubmit')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Permissions par serveur */}
      <Modal
        open={!!permsTarget}
        onClose={() => setPermsTarget(null)}
        title={permsTarget ? t('accounts.users.permsModalTitle', { name: permsTarget.username }) : ''}
        size="lg"
      >
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {servers.length === 0 ? (
            <p className="text-sm text-fg-3">{t('accounts.users.noServers')}</p>
          ) : servers.map(srv => {
            const checked = new Set(permsDraft[srv.id] || []);
            return (
              <div key={srv.id} className="rounded-lg border border-line p-3.5 space-y-2.5">
                <div className="font-medium text-fg text-sm">{srv.name}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {PERM_KEYS.map(perm => {
                    const cbId = `${formId}-perm-${srv.id}-${perm}`;
                    return (
                      <label
                        key={perm}
                        htmlFor={cbId}
                        className="flex items-start gap-2.5 p-2 rounded-md border border-line/60 hover:bg-surface-2/50 cursor-pointer"
                      >
                        <input
                          id={cbId}
                          type="checkbox"
                          className="mt-0.5 accent-fg"
                          checked={checked.has(perm)}
                          onChange={() => togglePerm(srv.id, perm)}
                        />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-fg leading-tight">
                            {t(`accounts.perms.${perm}`)}
                          </span>
                          <span className="block text-[11.5px] text-fg-3 mt-0.5 leading-snug">
                            {t(`accounts.perms.${perm}Desc`)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setPermsTarget(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={savePermsMut.isPending}
              onClick={() => savePermsMut.mutate()}
            >
              {t('accounts.users.savePerms')}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        title={deleteTarget ? t('accounts.users.deleteTitle', { name: deleteTarget.username }) : ''}
        message={t('accounts.users.deleteDesc')}
        busy={deleteMut.isPending}
      />
    </Page>
  );
}
