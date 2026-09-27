// Routes /api/servers, regroupées par domaine.
const express = require('express');

const router = express.Router();
router.use(require('./lifecycle'));
router.use(require('./world'));
router.use(require('./players'));
router.use(require('./files'));

module.exports = router;
