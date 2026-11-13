// Extension profils : expose le nom du profil actif dans la réponse JSON des serveurs.
module.exports = {
  name: 'profiles',
  decorate(row) {
    return { active_profile_name: row.active_profile_name ?? null };
  },
};
