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

const STATUS_DOT_COLOR = {
  running:    'var(--accent)',
  stopped:    '#6B6B76',
  installing: '#FBBF24',
  updating:   '#FBBF24',
  error:      '#F87171',
};

function NavItem({ to, icon: Icon, label, collapsed }) {
  return (
    <NavLink
      to={to}
      end
      title={collapsed ? label : undefined}
      className={({ isActive }) => clsx(
        'flex items-center gap-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 group relative',
        collapsed ? 'justify-center px-0 w-10 mx-auto' : 'px-3',
        isActive
          ? 'bg-[#1C1C21] text-[#F0F0F0]'
          : 'text-[#6B6B76] hover:bg-[#1C1C21] hover:text-[#F0F0F0]'
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && !collapsed && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[#F0F0F0] rounded-r-full" />
          )}
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
    logout();
    navigate('/login');
  }

  return (
    <aside
      style={{
        width: collapsed ? '64px' : '240px',
        transition: 'width 0.3s cubic-bezier(0.16,1,0.3,1)',
        flexShrink: 0,
        borderRight: '1px solid rgba(255,255,255,0.06)',
      }}
      className="flex flex-col overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      {/* Logo */}
      <div
        className={clsx(
          'flex items-center py-5 mb-1',
          collapsed ? 'justify-center px-0' : 'gap-3 px-4'
        )}
      >
        <div className="w-8 h-8 rounded-lg bg-[#F0F0F0] flex items-center justify-center shrink-0">
          <Layers size={16} strokeWidth={2} className="text-black" />
        </div>
        {!collapsed && (
          <span className="font-semibold text-[#F0F0F0] text-sm tracking-tight" style={{ opacity: 1, transition: 'opacity 0.2s' }}>
            Craftarr
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 space-y-0.5">
        <NavItem to="/catalog" icon={LayoutDashboard} label={t('nav.catalogue')} collapsed={collapsed} />

        {!collapsed ? (
          <div>
            <button
              onClick={() => setServersOpen(o => !o)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-[#6B6B76] hover:bg-[#1C1C21] hover:text-[#F0F0F0] transition-all duration-200"
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
              <div className="mt-0.5 ml-4 pl-3 border-l space-y-0.5" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                {servers.length === 0 ? (
                  <p className="text-xs text-[#4A4A55] px-3 py-2">{t('nav.noServers')}</p>
                ) : (
                  servers.map(server => (
                    <NavLink
                      key={server.id}
                      to={`/servers/${server.id}`}
                      className={({ isActive }) => clsx(
                        'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all duration-200 relative',
                        isActive
                          ? 'bg-[#1C1C21] text-[#F0F0F0] font-medium'
                          : 'text-[#6B6B76] hover:bg-[#1C1C21] hover:text-[#F0F0F0]'
                      )}
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && (
                            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-[#F0F0F0] rounded-r-full" />
                          )}
                          <span
                            className={clsx('w-1.5 h-1.5 rounded-full shrink-0', server.status === 'running' && 'pulse-dot')}
                            style={{ background: STATUS_DOT_COLOR[server.status] || STATUS_DOT_COLOR.stopped }}
                          />
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
          <NavLink
            to="#"
            title={t('nav.servers')}
            className="flex items-center justify-center w-10 mx-auto py-2 rounded-lg text-[#6B6B76] hover:bg-[#1C1C21] hover:text-[#F0F0F0] transition-all duration-200"
          >
            <Server size={18} strokeWidth={1.5} />
          </NavLink>
        )}

        <NavItem to="/settings" icon={Settings} label={t('nav.settings')} collapsed={collapsed} />
      </nav>

      {/* Footer */}
      <div className="px-2 pb-3 pt-2 space-y-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {!collapsed && (
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-md bg-[#1C1C21] flex items-center justify-center text-[10px] font-bold text-[#6B6B76] uppercase shrink-0">
                {user?.username?.[0] || '?'}
              </div>
              <span className="text-xs text-[#6B6B76] truncate">{user?.username}</span>
            </div>
            <button
              onClick={handleLogout}
              className="p-1 rounded-md hover:bg-[#1C1C21] text-[#4A4A55] hover:text-[#F87171] transition-colors"
              title={t('nav.logout')}
            >
              <LogOut size={13} strokeWidth={1.5} />
            </button>
          </div>
        )}
        <button
          onClick={() => setCollapsed(c => !c)}
          className={clsx(
            'flex items-center justify-center rounded-lg text-[#4A4A55] hover:text-[#6B6B76] hover:bg-[#1C1C21] transition-all duration-200',
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
