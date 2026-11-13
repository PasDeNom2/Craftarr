// Extension planificateur : démarre la boucle et les déclencheurs événementiels.
module.exports = {
  name: 'scheduler',
  init({ events, io }) {
    require('../scheduler').start({ events, io });
  },
};
