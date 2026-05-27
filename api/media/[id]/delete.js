const { forward } = require('../../_express');

module.exports = (req, res) => {
  const id = req.query && req.query.id ? String(req.query.id) : '';
  return forward(req, res, `/api/media/${encodeURIComponent(id)}/delete`);
};
