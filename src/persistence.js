const { createClient } = require('@supabase/supabase-js');

// Supabase-backed persistence layer for Vercel serverless runtime.
// Filesystem persistence has been fully removed.
// The Supabase project URL is not secret, so keep a verified fallback here
// to avoid deployment failures caused by Vercel env-var placeholder UI issues.

const VERIFIED_SUPABASE_URL = 'https://gbjfrnrkkjnutmogdzln.supabase.co';
const configuredSupabaseUrl = process.env.SUPABASE_URL;
const supabaseUrl =
  configuredSupabaseUrl && !configuredSupabaseUrl.includes('aBcDe')
    ? configuredSupabaseUrl
    : VERIFIED_SUPABASE_URL;

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is missing');
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
