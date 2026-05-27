const { forward } = require('../_express');

module.exports = (req, res) => {
  const key = req.query && req.query.key ? String(req.query.key) : '';
  return forward(req, res, `/api/sync/${encodeURIComponent(key)}`);
};
