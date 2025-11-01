const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helpers per file
const loadJSON = file => JSON.parse(fs.readFileSync(path.join(__dirname, file)));
const saveJSON = (file, data) => {
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(data, null, 2));
};

// --- CONFIG ---
app.get('/api/config', (req, res) => {
  res.json(loadJSON('config.json'));
});
app.put('/api/config', (req, res) => {
  saveJSON('config.json', req.body);
  res.sendStatus(204);
});

// --- INTENTS ---
app.get('/api/intents', (req, res) => {
  res.json(loadJSON('intents.json'));
});
app.put('/api/intents', (req, res) => {
  saveJSON('intents.json', req.body);
  res.sendStatus(204);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server su http://localhost:${PORT}`));
