require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/scan-news', require('./api/scan-news'));
app.get('/api/homepage-feed', require('./api/homepage-feed'));
app.get('/api/news-feed', require('./api/news-feed'));
app.get('/api/editorial-queue', require('./api/editorial-queue'));
app.post('/api/approve-story', require('./api/approve-story'));
app.get('/api/approve-story', require('./api/approve-story'));
app.post('/api/reject-story', require('./api/reject-story'));
app.get('/api/reject-story', require('./api/reject-story'));
app.get('/api/system-status', require('./api/system-status'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Still Afloat Agent running on port ${PORT}`));
