// Source unique des couleurs d'état (badge, avatar, sidebar, en-têtes).
export const STATUS_COLOR = {
  running:    'var(--accent)',
  starting:   'var(--warn)',
  installing: 'var(--warn)',
  updating:   'var(--info)',
  stopped:    'var(--fg-3)',
  error:      'var(--danger)',
};

export const STATUS_RGB = {
  running:    'var(--accent-rgb)',
  starting:   'var(--warn-rgb)',
  installing: 'var(--warn-rgb)',
  updating:   'var(--info-rgb)',
  stopped:    'var(--fg-2-rgb)',
  error:      'var(--danger-rgb)',
};

/** États « vivants » : le bloc respire. */
export const STATUS_LIVE = new Set(['running', 'starting', 'installing', 'updating']);

export const statusColor = (status) => STATUS_COLOR[status] || STATUS_COLOR.stopped;
export const statusRgb = (status) => STATUS_RGB[status] || STATUS_RGB.stopped;
