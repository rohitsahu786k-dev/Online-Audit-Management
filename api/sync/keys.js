const { forward } = require('../_express');

module.exports = (req, res) => forward(req, res, '/api/sync/keys');
