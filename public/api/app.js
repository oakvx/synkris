const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
// monta le API di configurazione
app.use('/api', require('./api/config'));
// static files (front‑end)
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato su porta ${PORT}`);
});