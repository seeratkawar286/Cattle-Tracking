// Stub cattle routes — replace with real endpoints later
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Cattle routes placeholder - not yet implemented' });
});

module.exports = router;
