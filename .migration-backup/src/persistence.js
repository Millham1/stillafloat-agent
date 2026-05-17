const { createClient } = require('@supabase/supabase-js');

// Supabase-backed persistence layer for Vercel serverless runtime.
// Filesystem persistence has been fully removed.
// Prototype/editorial-stage configuration uses anon/public access
// to eliminate unnecessary service-role secret management.

const VERIFIED_SUPABASE_URL = 'https://gbjfrnrkkjnutmogdzln.supabase.co';
const configuredSupabaseUrl = process.env.SUPABASE_URL;
const supabaseUrl =
  configuredSupabaseUrl && !configuredSupabaseUrl.includes('aBcDe')
    ? configuredSupabaseUrl
    : VERIFIED_SUPABASE_URL;

const supabaseKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseKey) {
  throw new Error('SUPABASE_ANON_KEY environment variable is missing');
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
