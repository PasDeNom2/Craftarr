import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useServerStore, useAuthStore } from '../../store';
import { useI18n } from '../../i18n';
import clsx from 'clsx';
import {
  LayoutDashboard,
  Server,
  ChevronDown,
  ChevronUp,
  Settings,
  LogOut,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import ServerAvatar from '../ui/ServerAvatar';
import { resetSocket } from '../../hooks/useSocket';


function NavItem({ to, icon: Icon, label, collapsed }) {
  return (
    <NavLink
      to={to}
      end
      title={collapsed ? label : undefined}
      className={({ isActive }) => clsx(
        'flex items-center gap-3 py-2 rounded-xl text-sm font-medium transition-all duration-200 relative',
        collapsed ? 'justify-center px-0 w-10 mx-auto' : 'px-3',
        isActive
          ? 'bg-white/[0.12] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]'
          : 'text-fg-2 hover:bg-surface-2 hover:text-fg'
      )}
    >
      {({ isActive }) => (
        <>
          <Icon size={18} strokeWidth={1.5} className="shrink-0" />
          {!collapsed && <span>{label}</span>}
        </>
      )}
    </NavLink>
  );
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [serversOpen, setServersOpen] = useState(true);
  const servers = useServerStore(s => s.servers);
  const logout = useAuthStore(s => s.logout);
  const user = useAuthStore(s => s.user);
  const navigate = useNavigate();
  const { t } = useI18n();

  const runningCount = servers.filter(s => s.status === 'running').length;

  function handleLogout() {
    // Ferme le socket authentifié avec l'ancien token (sinon il resterait ouvert après la déconnexion)
    resetSocket();
    logout();
    navigate('/login');
  }

  return (
    <aside
      style={{
        width: collapsed ? '68px' : '248px',
        transition: 'width 0.35s cubic-bezier(0.2,0.8,0.2,1)',
        flexShrink: 0,
      }}
      className="glass flex flex-col overflow-hidden rounded-[26px]"
    >
      {/* Logo */}
      <div
        className={clsx(
          'flex items-center py-5 mb-1',
          collapsed ? 'justify-center px-0' : 'gap-3 px-4'
        )}
      >
        <div className="w-8 h-8 rounded-[10px] bg-fg flex items-center justify-center shrink-0">
          <Layers size={16} strokeWidth={2} className="text-black" />
        </div>
        {!collapsed && (
          <span className="font-semibold text-fg text-sm tracking-tight">
            Craftarr
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 space-y-0.5">
        <NavItem to="/catalog" icon={LayoutDashboard} label={t('nav.catalogue')} collapsed={collapsed} />

        {/* Servers section */}
        {!collapsed ? (
          <div>
            <button
              onClick={() => setServersOpen(o => !o)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-fg-2 hover:bg-surface-2 hover:text-fg transition-all duration-200"
            >
              <Server size={18} strokeWidth={1.5} className="shrink-0" />
              <span className="flex-1 text-left">{t('nav.servers')}</span>
              {runningCount > 0 && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md" style={{ color: 'var(--accent)', background: 'rgba(var(--accent-rgb),0.1)' }}>
                  {runningCount}
                </span>
              )}
              {serversOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            {serversOpen && (
              <div className="mt-0.5 ml-4 pl-2 space-y-0.5">
                {servers.length === 0 ? (
                  <p className="text-xs text-fg-3 px-3 py-2">{t('nav.noServers')}</p>
                ) : (
                  servers.map(server => (
                    <NavLink
                      key={server.id}
                      to={`/servers/${server.id}`}
                      className={({ isActive }) => clsx(
                        'flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all duration-200 relative',
                        isActive
                          ? 'bg-white/[0.12] text-fg font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]'
                          : 'text-fg-2 hover:bg-surface-2 hover:text-fg'
                      )}
                    >
                      {({ isActive }) => (
                        <>
                          <ServerAvatar server={server} size={22} showDot />
                          <span className="truncate flex-1">{server.name}</span>
                        </>
                      )}
                    </NavLink>
                  ))
                )}
              </div>
            )}
          </div>
        ) : (
          /* Collapsed: show each server as a dot-icon with tooltip */
          <div className="space-y-0.5">
            <div
              title={t('nav.servers')}
              className="flex items-center justify-center w-10 mx-auto py-2 rounded-lg text-fg-2 cursor-default"
            >
              <Server size={18} strokeWidth={1.5} />
            </div>
            {servers.map(server => (
              <NavLink
                key={server.id}
                to={`/servers/${server.id}`}
                title={`${server.name} — ${server.status}`}
                className={({ isActive }) => clsx(
                  'flex items-center justify-center w-10 mx-auto py-1.5 rounded-lg transition-all duration-200',
                  isActive ? 'bg-white/[0.12]' : 'hover:bg-surface-2'
                )}
              >
                <ServerAvatar server={server} size={30} showDot />
              </NavLink>
            ))}
          </div>
        )}

        <NavItem to="/settings" icon={Settings} label={t('nav.settings')} collapsed={collapsed} />
      </nav>

      {/* Footer */}
      <div className="px-2 pb-3 pt-2 space-y-1 border-t border-line">
        {!collapsed && (
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-md bg-surface-2 flex items-center justify-center text-[10px] font-bold text-fg-2 uppercase shrink-0">
                {user?.username?.[0] || '?'}
              </div>
              <span className="text-xs text-fg-2 truncate">{user?.username}</span>
            </div>
            <button
              onClick={handleLogout}
              className="p-1 rounded-md hover:bg-surface-2 text-fg-3 hover:text-danger transition-colors"
              title={t('nav.logout')}
            >
              <LogOut size={13} strokeWidth={1.5} />
            </button>
          </div>
        )}
        {collapsed && (
          <button
            onClick={handleLogout}
            className="flex items-center justify-center w-10 mx-auto py-1.5 rounded-lg text-fg-3 hover:text-danger hover:bg-surface-2 transition-colors"
            title={t('nav.logout')}
          >
            <LogOut size={13} strokeWidth={1.5} />
          </button>
        )}
        <button
          onClick={() => setCollapsed(c => !c)}
          className={clsx(
            'flex items-center justify-center rounded-lg text-fg-3 hover:text-fg-2 hover:bg-surface-2 transition-all duration-200',
            collapsed ? 'w-10 h-8 mx-auto' : 'w-full h-8'
          )}
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          {collapsed
            ? <PanelLeftOpen size={15} strokeWidth={1.5} />
            : <PanelLeftClose size={15} strokeWidth={1.5} />
          }
        </button>
      </div>
    </aside>
  );
}
