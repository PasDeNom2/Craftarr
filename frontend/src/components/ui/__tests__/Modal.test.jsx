import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from '../Modal';
import { I18nProvider } from '../../../i18n';

describe('Modal', () => {
  beforeEach(() => {
    localStorage.setItem('mcm_lang', 'en');
  });

  it('renders dialog with aria-modal and calls onClose on Escape when not dirty', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <Modal open onClose={onClose} title="Settings">
          <p>Modal content</p>
        </Modal>
      </I18nProvider>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows discard confirmation on Escape when dirty without calling onClose immediately', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <Modal open onClose={onClose} title="Edit file" dirty>
          <p>Unsaved editor</p>
        </Modal>
      </I18nProvider>,
    );

    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
