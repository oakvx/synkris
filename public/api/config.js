const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const CONFIG_PATH = path.join(__dirname, 'config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

router.get('/config', (req, res) => {
  try {
    res.json(readConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', (req, res) => {
  try {
    writeConfig(req.body);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;