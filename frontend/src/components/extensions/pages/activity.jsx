import React, { useId, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { getServers } from '../../../services/api';
import { getActivity } from '../../../services/features/accounts';
import { useAuthStore } from '../../../store';
import { useI18n } from '../../../i18n';
import { parseDbDate } from '../../../utils/dates';
import PageHeader, { Page } from '../../layout/PageHeader';

export const page = {
  path: 'activity',
  navKey: 'accounts.activityNav',
  Icon: ScrollText,
  order: 20,
  adminOnly: true,
};

function statusBadgeClass(status) {
  if (status >= 500) return 'badge bg-danger/15 text-danger';
  if (status >= 400) return 'badge bg-amber-500/15 text-amber-400';
  return 'badge bg-success/15 text-success';
}

export default function ActivityPage() {
  const { t, locale } = useI18n();
  const currentUser = useAuthStore(s => s.user);
  const id = useId();

  const [userFilter, setUserFilter] = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [pageNum, setPageNum] = useState(1);

  const isAdmin = currentUser?.role === 'admin';

  const { data: servers = [] } = useQuery({
    queryKey: ['servers'],
    queryFn: getServers,
    enabled: isAdmin,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['activity', userFilter, serverFilter, actionFilter, fromFilter, toFilter, pageNum],
    queryFn: () => getActivity({
      user: userFilter.trim(),
      server: serverFilter,
      action: actionFilter.trim(),
      from: fromFilter,
      to: toFilter,
      page: pageNum,
      limit: 50,
    }),
    enabled: isAdmin,
  });

  if (currentUser && currentUser.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  if (!currentUser) {
    return null;
  }

  function resetFilters() {
    setUserFilter('');
    setServerFilter('');
    setActionFilter('');
    setFromFilter('');
    setToFilter('');
    setPageNum(1);
  }

  function formatDate(raw) {
    const d = parseDbDate(raw);
    if (!d) return '—';
    return d.toLocaleString(locale === 'en' ? 'en-US' : 'fr-FR', {
      dateStyle: 'short',
      timeStyle: 'medium',
    });
  }

  const items = data?.items || [];
  const total = data?.total || 0;
  const totalPages = data?.totalPages || 1;

  return (
    <Page wide>
      <PageHeader
        title={t('accounts.activity.title')}
        description={t('accounts.activity.subtitle')}
      />

      {/* Filtres */}
      <div className="card mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
        <div>
          <label htmlFor={`${id}-user`} className="label">{t('accounts.activity.colUser')}</label>
          <input
            id={`${id}-user`}
            className="input"
            value={userFilter}
            onChange={e => { setUserFilter(e.target.value); setPageNum(1); }}
            placeholder={t('accounts.activity.filterUser')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-server`} className="label">{t('accounts.activity.colServer')}</label>
          <select
            id={`${id}-server`}
            className="input"
            value={serverFilter}
            onChange={e => { setServerFilter(e.target.value); setPageNum(1); }}
          >
            <option value="">{t('accounts.activity.filterServer')}</option>
            {servers.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-action`} className="label">{t('accounts.activity.colAction')}</label>
          <input
            id={`${id}-action`}
            className="input font-mono text-[13px]"
            value={actionFilter}
            onChange={e => { setActionFilter(e.target.value); setPageNum(1); }}
            placeholder={t('accounts.activity.filterAction')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-from`} className="label">{t('accounts.activity.filterFrom')}</label>
          <input
            id={`${id}-from`}
            type="date"
            className="input"
            value={fromFilter}
            onChange={e => { setFromFilter(e.target.value); setPageNum(1); }}
          />
        </div>
        <div>
          <label htmlFor={`${id}-to`} className="label">{t('accounts.activity.filterTo')}</label>
          <input
            id={`${id}-to`}
            type="date"
            className="input"
            value={toFilter}
            onChange={e => { setToFilter(e.target.value); setPageNum(1); }}
          />
        </div>
        <div>
          <button type="button" className="btn-secondary w-full" onClick={resetFilters}>
            <RotateCcw size={14} /> {t('accounts.activity.resetFilters')}
          </button>
        </div>
      </div>

      {/* Tableau */}
      <div className="card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-fg-3 uppercase tracking-wider">
                <th className="py-3 px-4 font-medium">{t('accounts.activity.colDate')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.activity.colUser')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.activity.colAction')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.activity.colServer')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.activity.colStatus')}</th>
                <th className="py-3 px-4 font-medium">{t('accounts.activity.colIp')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-fg-3">…</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-fg-3">{t('accounts.activity.empty')}</td>
                </tr>
              ) : items.map(item => (
                <tr key={item.id} className="hover:bg-surface-2/60 transition-colors">
                  <td className="py-2.5 px-4 text-fg-2 whitespace-nowrap">{formatDate(item.at)}</td>
                  <td className="py-2.5 px-4 font-medium text-fg">
                    {item.username || <span className="text-fg-3 italic">{t('accounts.activity.anonymous')}</span>}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[12.5px] text-fg-2">{item.action}</td>
                  <td className="py-2.5 px-4 text-fg-2">
                    {item.server_name || (item.server_id ? item.server_id.slice(0, 8) : '—')}
                  </td>
                  <td className="py-2.5 px-4">
                    <span className={clsx(statusBadgeClass(item.status), 'font-mono')}>
                      {item.status ?? '—'}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[12px] text-fg-3">{item.ip || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-line text-[12.5px] text-fg-2">
          <span>{t('accounts.activity.totalCount', { total })}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary !py-1 !px-2.5 !text-[12px]"
              disabled={pageNum <= 1}
              onClick={() => setPageNum(p => Math.max(1, p - 1))}
            >
              <ChevronLeft size={14} /> {t('accounts.activity.prev')}
            </button>
            <span>{t('accounts.activity.pageOf', { page: pageNum, totalPages })}</span>
            <button
              type="button"
              className="btn-secondary !py-1 !px-2.5 !text-[12px]"
              disabled={pageNum >= totalPages}
              onClick={() => setPageNum(p => Math.min(totalPages, p + 1))}
            >
              {t('accounts.activity.next')} <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </Page>
  );
}
