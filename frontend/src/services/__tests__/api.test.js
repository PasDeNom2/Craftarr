import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, login, setupAdmin, getServers } from '../api';

describe('api 401 response interceptor', () => {
  let originalAdapter;

  beforeEach(() => {
    originalAdapter = api.defaults.adapter;
    api.defaults.adapter = async (config) => {
      throw Object.assign(new Error('401'), {
        config,
        response: { status: 401, data: {} },
      });
    };
    localStorage.setItem('mcm_token', 'jwt-token');
    vi.stubGlobal('location', { pathname: '/servers', href: 'http://localhost/servers' });
  });

  afterEach(() => {
    api.defaults.adapter = originalAdapter;
    vi.unstubAllGlobals();
  });

  it('does not redirect or remove token for /auth/login', async () => {
    await expect(login('admin', 'wrong')).rejects.toThrow('401');

    expect(localStorage.getItem('mcm_token')).toBe('jwt-token');
    expect(window.location.href).toBe('http://localhost/servers');
  });

  it('does not redirect or remove token for /auth/setup', async () => {
    await expect(setupAdmin('admin', 'password123', 'bad-token')).rejects.toThrow('401');

    expect(localStorage.getItem('mcm_token')).toBe('jwt-token');
    expect(window.location.href).toBe('http://localhost/servers');
  });

  it('removes mcm_token and redirects to /login for other URLs', async () => {
    await expect(getServers()).rejects.toThrow('401');

    expect(localStorage.getItem('mcm_token')).toBeNull();
    expect(window.location.href).toBe('/login');
  });

  it('removes mcm_token without reassigning href when already on /login', async () => {
    vi.stubGlobal('location', { pathname: '/login', href: 'http://localhost/login' });

    await expect(getServers()).rejects.toThrow('401');

    expect(localStorage.getItem('mcm_token')).toBeNull();
    expect(window.location.href).toBe('http://localhost/login');
  });
});
