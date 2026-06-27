const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Alarm routes placeholder - not yet implemented' });
});

module.exports = router;
