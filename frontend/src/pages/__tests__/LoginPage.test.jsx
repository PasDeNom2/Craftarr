import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';
import LoginPage from '../LoginPage';
import { I18nProvider } from '../../i18n';
import { login } from '../../services/api';
import { useAuthStore } from '../../store';

vi.mock('../../services/api', () => ({
  login: vi.fn(),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('mcm_lang', 'en');
    useAuthStore.setState({ token: null, user: null });
  });

  afterEach(() => {
    toast.remove();
  });

  it('displays error toast and stays on the login form when credentials are invalid', async () => {
    const user = userEvent.setup();
    login.mockRejectedValueOnce({
      response: { status: 401, data: { error: 'Identifiants invalides' } },
    });

    render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/login']}>
          <Toaster />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>Dashboard</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Identifiants invalides')).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith('admin', 'wrong-password');
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });
});
