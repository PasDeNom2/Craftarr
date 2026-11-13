/**
 * Ligne de la table `servers` (src/config/schema.sql + migrations de src/config/database.js).
 * @typedef {Object} ServerRow
 * @property {string} id
 * @property {string} name
 * @property {string} modpack_id
 * @property {string} modpack_name
 * @property {string} modpack_source
 * @property {string | null} modpack_version
 * @property {string | null} modpack_version_id
 * @property {string | null} modpack_download_url
 * @property {string | null} container_id
 * @property {string | null} container_name
 * @property {number} port
 * @property {number} rcon_port
 * @property {string} rcon_password
 * @property {number} ram_mb
 * @property {number} max_players
 * @property {string | null} seed
 * @property {number} whitelist_enabled
 * @property {number} online_mode
 * @property {string} status
 * @property {string | null} mc_version
 * @property {string | null} loader_type
 * @property {number} auto_update
 * @property {number} update_interval_hours
 * @property {string} created_at
 * @property {string | null} last_seen
 * @property {string | null} motd
 * @property {string} difficulty
 * @property {number} view_distance
 * @property {number} spawn_protection
 * @property {number} needs_recreate
 * @property {number} pregen_enabled
 * @property {number} pregen_radius
 * @property {number} pregen_pause_players
 * @property {string | null} pregen_status
 * @property {number} pregen_progress
 * @property {string | null} pregen_eta
 * @property {string | null} pregen_message
 * @property {string} pregen_worlds
 * @property {number} pregen_world_index
 */

/**
 * Erreur HTTP enrichie d'un statut optionnel et d'un indicateur d'exposition du message.
 * @typedef {Error & { status?: number, statusCode?: number, expose?: boolean }} HttpError
 */

module.exports = {};
