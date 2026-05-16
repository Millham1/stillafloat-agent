const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

const PATHS = {
  candidates: path.join(DATA_DIR, 'candidate-stories.json'),
  approved: path.join(DATA_DIR, 'approved-stories.json'),
  archive: path.join(DATA_DIR, 'archive-stories.json'),
  homepage: path.join(DATA_DIR, 'homepage-feed.json'),
  newsIndex: path.join(DATA_DIR, 'news-index.json'),
  storyDetails: path.join(DATA_DIR, 'story-details.json')
};

module.exports = {
  PATHS,
  writeJson,
  readJson
};