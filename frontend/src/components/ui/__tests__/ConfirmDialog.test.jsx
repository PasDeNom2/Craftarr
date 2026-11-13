import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from '../ConfirmDialog';
import { I18nProvider } from '../../../i18n';

describe('ConfirmDialog', () => {
  beforeEach(() => {
    localStorage.setItem('mcm_lang', 'en');
  });

  it('renders children and requires exact requireText before enabling confirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <ConfirmDialog
          open
          onClose={onClose}
          onConfirm={onConfirm}
          title="Delete server"
          message="This action is permanent."
          confirmLabel="Delete"
          requireText="mon-serveur"
        >
          <p>Extra warning details</p>
        </ConfirmDialog>
      </I18nProvider>,
    );

    expect(screen.getByText('Extra warning details')).toBeInTheDocument();

    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    const input = screen.getByPlaceholderText('mon-serveur');

    expect(confirmBtn).toBeDisabled();

    await user.type(input, 'mon-serv');
    expect(confirmBtn).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.type(input, 'eur');
    expect(confirmBtn).toBeEnabled();

    await user.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
