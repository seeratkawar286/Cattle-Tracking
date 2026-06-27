const express = require('express');
const router = express.Router();

router.post('/login', (req, res) => {
  res.status(501).json({ message: 'Auth not yet implemented' });
});

module.exports = router;
