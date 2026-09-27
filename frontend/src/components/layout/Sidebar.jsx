import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Compass, Settings, LogOut, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { useServerStore, useAuthStore } from '../../store';
import { useI18n } from '../../i18n';
import ServerAvatar from '../ui/ServerAvatar';
import Logo, { LogoMark } from '../ui/Logo';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import { resetSocket } from '../../hooks/useSocket';
import { statusColor } from '../ui/status';

const COLLAPSE_KEY = 'craftarr_sidebar_collapsed';
function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

// Élément de navigation : barre d'accent lumineuse à gauche quand actif
function NavItem({ to, icon: Icon, label, collapsed, end = true }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      className={({ isActive }) => clsx(
        'group relative flex items-center gap-3 h-9 rounded-[10px] text-[13px] font-medium transition-colors duration-150',
        collapsed ? 'justify-center w-10 mx-auto' : 'px-3',
        isActive ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r"
              style={{ background: 'var(--accent)', boxShadow: '0 0 12px rgba(var(--accent-rgb),0.8)' }}
            />
          )}
          <Icon size={17} strokeWidth={1.75} className={clsx('shrink-0', isActive && 'text-accent')} />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  );
}

function ServerItem({ server, collapsed }) {
  const { t } = useI18n();
  return (
    <NavLink
      to={`/servers/${server.id}`}
      title={collapsed ? `${server.name} — ${t(`server.status.${server.status}`)}` : undefined}
      className={({ isActive }) => clsx(
        'group relative flex items-center rounded-[10px] transition-colors duration-150',
        collapsed ? 'justify-center w-10 h-10 mx-auto' : 'gap-2.5 px-2 py-1.5',
        isActive ? 'bg-surface-2' : 'hover:bg-surface-2',
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r"
              style={{ background: statusColor(server.status), boxShadow: `0 0 12px ${statusColor(server.status)}` }}
            />
          )}
          <ServerAvatar server={server} size={collapsed ? 30 : 28} showDot />
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className={clsx('block truncate text-[13px] leading-tight', isActive ? 'text-fg font-medium' : 'text-fg-2 group-hover:text-fg')}>
                {server.name}
              </span>
              <span className="block truncate text-[11px] text-fg-3 font-mono leading-tight mt-0.5">
                {[server.mc_version, server.loader_type !== 'vanilla' && server.loader_type].filter(Boolean).join(' · ') || '—'}
              </span>
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const servers = useServerStore(s => s.servers);
  const logout = useAuthStore(s => s.logout);
  const user = useAuthStore(s => s.user);
  const navigate = useNavigate();
  const { t } = useI18n();

  const runningCount = servers.filter(s => s.status === 'running').length;

  function toggleCollapsed() {
    setCollapsed(c => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch {}
      return !c;
    });
  }

  function handleLogout() {
    // Ferme le socket authentifié avec l'ancien token (sinon il resterait ouvert après la déconnexion)
    resetSocket();
    logout();
    navigate('/login');
  }

  return (
    <aside
      className="flex flex-col shrink-0 overflow-hidden bg-bg-2 border-r border-line"
      style={{ width: collapsed ? 68 : 252, transition: 'width .3s cubic-bezier(.16,1,.3,1)' }}
    >
      {/* Marque */}
      <div className={clsx('flex items-center h-16 shrink-0', collapsed ? 'justify-center' : 'px-5')}>
        {collapsed ? <LogoMark size={28} glow /> : <Logo size={28} />}
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 space-y-1">
        <NavItem to="/catalog" icon={Compass} label={t('nav.catalogue')} collapsed={collapsed} />
        <NavItem to="/settings" icon={Settings} label={t('nav.settings')} collapsed={collapsed} />

        {/* Serveurs */}
        <div className="pt-5">
          {!collapsed ? (
            <div className="flex items-center justify-between px-3 mb-2">
              <span className="eyebrow">{t('nav.servers')}</span>
              <span className="font-pixel text-[10px] text-fg-3" title={`${runningCount}/${servers.length}`}>
                <span className={runningCount ? 'text-accent' : ''}>{runningCount}</span>/{servers.length}
              </span>
            </div>
          ) : (
            <div className="mx-auto mb-2 w-6 border-t border-line" />
          )}

          <div className="space-y-0.5">
            {servers.length === 0 && !collapsed && (
              <NavLink
                to="/catalog"
                className="flex items-center gap-2 px-3 py-3 rounded-[10px] border border-dashed border-line text-xs text-fg-3 hover:text-fg-2 hover:border-line-strong transition-colors"
              >
                <Plus size={14} /> {t('nav.noServers')}
              </NavLink>
            )}
            {servers.map(server => <ServerItem key={server.id} server={server} collapsed={collapsed} />)}
          </div>
        </div>
      </nav>

      {/* Pied : compte, langue, repli */}
      <div className={clsx('shrink-0 border-t border-line p-3', collapsed ? 'space-y-2' : 'space-y-2')}>
        {!collapsed ? (
          <div className="flex items-center gap-2.5 px-1">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-pixel text-[12px] uppercase shrink-0"
              style={{ background: 'rgba(var(--accent-rgb),0.12)', color: 'var(--accent)', border: '1px solid rgba(var(--accent-rgb),0.25)' }}
            >
              {user?.username?.[0] || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-fg font-medium truncate leading-tight">{user?.username || '—'}</p>
              <p className="text-[11px] text-fg-3 leading-tight">Admin</p>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 rounded-lg text-fg-3 hover:text-danger hover:bg-surface-2 transition-colors"
              title={t('nav.logout')}
              aria-label={t('nav.logout')}
            >
              <LogOut size={15} strokeWidth={1.75} />
            </button>
          </div>
        ) : (
          <button
            onClick={handleLogout}
            className="flex items-center justify-center w-10 h-9 mx-auto rounded-lg text-fg-3 hover:text-danger hover:bg-surface-2 transition-colors"
            title={t('nav.logout')}
            aria-label={t('nav.logout')}
          >
            <LogOut size={15} strokeWidth={1.75} />
          </button>
        )}

        <div className={clsx('flex items-center', collapsed ? 'flex-col gap-1' : 'justify-between')}>
          <LanguageSwitcher placement="up" compact={collapsed} />
          <button
            onClick={toggleCollapsed}
            className="flex items-center justify-center w-9 h-8 rounded-lg text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors"
            title={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          >
            {collapsed ? <PanelLeftOpen size={15} strokeWidth={1.75} /> : <PanelLeftClose size={15} strokeWidth={1.75} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
