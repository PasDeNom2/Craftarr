import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { LayoutGrid, Compass, Settings, LogOut, Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useServerStore, useAuthStore } from '../../store';
import { useI18n } from '../../i18n';
import ServerAvatar from '../ui/ServerAvatar';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import { LogoMark } from '../ui/Logo';
import { resetSocket } from '../../hooks/useSocket';

const COLLAPSE_KEY = 'craftarr_sidebar_collapsed';

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

const itemClass = (isActive, collapsed) => clsx(
  'flex items-center gap-2.5 h-8 rounded-md text-[13px] transition-colors',
  collapsed ? 'justify-center w-8 mx-auto' : 'px-2.5',
  isActive ? 'bg-surface-2 text-fg font-medium' : 'text-fg-2 hover:text-fg hover:bg-tint/[0.04]',
);

function NavItem({ to, icon: Icon, label, collapsed, end = true }) {
  return (
    <NavLink to={to} end={end} title={collapsed ? label : undefined} className={({ isActive }) => itemClass(isActive, collapsed)}>
      <Icon size={16} strokeWidth={1.75} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
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

  function toggle() {
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
      className="flex flex-col shrink-0 h-full bg-bg-2 border-r border-line"
      style={{ width: collapsed ? 56 : 236, transition: 'width .2s ease' }}
    >
      {/* Marque */}
      <div className={clsx('flex items-center h-14 shrink-0', collapsed ? 'justify-center' : 'gap-2.5 px-4')}>
        <LogoMark size={24} />
        {!collapsed && <span className="font-semibold text-fg text-[14px] tracking-tight">Craftarr</span>}
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
        <div className="space-y-0.5">
          <NavItem to="/" icon={LayoutGrid} label={t('nav.overview')} collapsed={collapsed} />
          <NavItem to="/catalog" icon={Compass} label={t('nav.catalogue')} collapsed={collapsed} />
        </div>

        {/* Serveurs */}
        <div className="mt-5">
          {!collapsed && (
            <div className="flex items-center justify-between px-2.5 mb-1">
              <span className="eyebrow">{t('nav.servers')}</span>
              <NavLink to="/catalog" className="icon-btn !h-6 !min-w-6" title={t('nav.newServer')} aria-label={t('nav.newServer')}>
                <Plus size={14} strokeWidth={2} />
              </NavLink>
            </div>
          )}
          <div className="space-y-0.5">
            {servers.length === 0 && !collapsed && (
              <p className="text-[12px] text-fg-3 px-2.5 py-1.5">{t('nav.noServers')}</p>
            )}
            {servers.map(server => (
              <NavLink
                key={server.id}
                to={`/servers/${server.id}`}
                title={collapsed ? server.name : undefined}
                className={({ isActive }) => clsx(itemClass(isActive, collapsed), !collapsed && 'h-9')}
              >
                <ServerAvatar server={server} size={collapsed ? 22 : 20} showDot />
                {!collapsed && <span className="truncate flex-1">{server.name}</span>}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      {/* Pied : paramètres, langue, compte */}
      <div className="shrink-0 border-t border-line p-2 space-y-0.5">
        <NavItem to="/settings" icon={Settings} label={t('nav.settings')} collapsed={collapsed} />
        {!collapsed ? (
          <div className="flex items-center gap-2 h-10 pl-2.5 pr-1">
            <div className="w-6 h-6 rounded-full bg-surface-2 border border-line-strong flex items-center justify-center text-[11px] font-semibold text-fg-2 uppercase shrink-0">
              {user?.username?.[0] || '?'}
            </div>
            <span className="text-[13px] text-fg-2 truncate flex-1">{user?.username}</span>
            <LanguageSwitcher placement="up" compact />
            <button onClick={handleLogout} className="icon-btn" title={t('nav.logout')} aria-label={t('nav.logout')}>
              <LogOut size={14} strokeWidth={1.75} />
            </button>
          </div>
        ) : (
          <button onClick={handleLogout} className={itemClass(false, true)} title={t('nav.logout')} aria-label={t('nav.logout')}>
            <LogOut size={15} strokeWidth={1.75} />
          </button>
        )}
        <button
          onClick={toggle}
          className={clsx(itemClass(false, collapsed), 'w-full text-fg-3')}
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          {collapsed ? <PanelLeftOpen size={15} strokeWidth={1.75} /> : <PanelLeftClose size={15} strokeWidth={1.75} />}
          {!collapsed && <span>{t('nav.collapse')}</span>}
        </button>
      </div>
    </aside>
  );
}
