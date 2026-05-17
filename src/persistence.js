const { createClient } = require('@supabase/supabase-js');

// Supabase-backed persistence layer for Vercel serverless runtime.
// Filesystem persistence has been fully removed.

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase environment variables are missing');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const PATHS = {
  candidates: 'candidate-stories',
  approved: 'approved-stories',
  archive: 'archive-stories',
  homepage: 'homepage-feed',
  newsIndex: 'news-index',
  storyDetails: 'story-details'
};

async function writeJson(key, payload) {
  const { error } = await supabase
    .from('platform_state')
    .upsert({
      id: key,
      payload,
      updated_at: new Date().toISOString()
    });

  if (error) {
    throw error;
  }

  return true;
}

async function readJson(key, fallback = {}) {
  const { data, error } = await supabase
    .from('platform_state')
    .select('payload')
    .eq('id', key)
    .single();

  if (error || !data) {
    return fallback;
  }

  return data.payload || fallback;
}

module.exports = {
  PATHS,
  writeJson,
  readJson,
  supabase
};