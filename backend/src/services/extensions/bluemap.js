// @ts-check
// Extension BlueMap : publication du port web interne (8100/tcp) et champs exposés dans l'API serveur.

module.exports = {
  name: 'bluemap',

  /**
   * Publie le port web interne 8100/tcp sur bluemap_port si BlueMap est activé.
   * @param {Record<string, any>} server
   */
  ports(server) {
    if (!server?.bluemap_enabled || !server?.bluemap_port) {
      return { exposed: {}, bindings: {} };
    }
    return {
      exposed: { '8100/tcp': {} },
      bindings: { '8100/tcp': [{ HostPort: String(server.bluemap_port) }] },
    };
  },

  /**
   * Ajoute bluemap_enabled et bluemap_port à la représentation JSON d'un serveur.
   * @param {Record<string, any>} row
   */
  decorate(row) {
    // Ligne sans colonnes BlueMap (objet partiel) : rien à ajouter
    if (!row || !('bluemap_enabled' in row)) return {};
    return {
      bluemap_enabled: !!row.bluemap_enabled,
      bluemap_port: row.bluemap_port ?? null,
    };
  },
};
