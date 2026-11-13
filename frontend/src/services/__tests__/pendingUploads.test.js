import { describe, it, expect, beforeEach, vi } from 'vitest';
import { queueUploads, clearUploads, flushUploads } from '../pendingUploads';
import { uploadServerIcon, importWorld } from '../api';

vi.mock('../api', () => ({
  uploadServerIcon: vi.fn(),
  importWorld: vi.fn(),
}));

describe('pendingUploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUploads('srv-1');
    clearUploads('srv-2');
  });

  it('uploads icon then imports world when flushing queued uploads', async () => {
    uploadServerIcon.mockResolvedValue({});
    importWorld.mockResolvedValue({});

    const iconFile = new File(['icon'], 'icon.png', { type: 'image/png' });
    const worldFile = new File(['world'], 'world.zip', { type: 'application/zip' });

    queueUploads('srv-1', { icon: iconFile, world: worldFile });
    await flushUploads('srv-1');

    expect(uploadServerIcon).toHaveBeenCalledTimes(1);
    expect(uploadServerIcon).toHaveBeenCalledWith('srv-1', iconFile);
    expect(importWorld).toHaveBeenCalledTimes(1);
    expect(importWorld).toHaveBeenCalledWith('srv-1', worldFile);
    expect(uploadServerIcon.mock.invocationCallOrder[0]).toBeLessThan(
      importWorld.mock.invocationCallOrder[0],
    );
  });

  it('clears queued uploads via clearUploads', async () => {
    const iconFile = new File(['icon'], 'icon.png', { type: 'image/png' });

    queueUploads('srv-2', { icon: iconFile });
    const cleared = clearUploads('srv-2');

    expect(cleared).toEqual({ icon: iconFile });

    await flushUploads('srv-2');
    expect(uploadServerIcon).not.toHaveBeenCalled();
    expect(importWorld).not.toHaveBeenCalled();
  });

  it('does nothing when flushing an unknown server', async () => {
    await flushUploads('unknown-server');

    expect(uploadServerIcon).not.toHaveBeenCalled();
    expect(importWorld).not.toHaveBeenCalled();
  });
});
