const homepageContainer = document.getElementById('news-container');
const fullNewsFeed = document.getElementById('full-news-feed');

const AGENT_BASE_URL = '';

// Locale detection — Spanish pages live under /es/
const isSpanish = window.location.pathname.startsWith('/es/');

let allStories = [];
let renderedCount = 0;
const STORIES_PER_BATCH = 10;

// ── Locale strings ──────────────────────────────────────────────
const L = isSpanish ? {
  liveIntel:        'Inteligencia de Cruceros en Vivo',
  headlineFeed:     'Noticias de Cruceros y Viajes',
  storiesLoaded:    n => `${n} historias cargadas`,
  loadMore:         'Cargar más historias',
  openDetail:       'Ver detalle →',
  noStoriesHome:    'No hay historias de cruceros disponibles en este momento.',
  noStoriesFull:    'No hay historias de cruceros disponibles.',
  loadError:        'Las noticias de cruceros en vivo no están disponibles temporalmente. Por favor recarga en breve.',
  badgeImpact:      '✈️ Impacto en Viajes',
  badgePulse:       '🚢 Pulso de Cruceros',
  badgeDirect:      '📡 Directo de las Líneas',
  badgeLife:        '🌴 Vida en el Crucero',
} : {
  liveIntel:        'Live Cruise Intelligence',
  headlineFeed:     'Cruise News & Travel Pulse',
  storiesLoaded:    n => `${n} stories loaded`,
  loadMore:         'Load More Stories',
  openDetail:       'Open Story Detail →',
  noStoriesHome:    'No live cruise stories are currently available.',
  noStoriesFull:    'No live cruise stories available.',
  loadError:        'Live cruise news is temporarily unavailable. Please refresh shortly.',
  badgeImpact:      '✈️ Travel Impact',
  badgePulse:       '🚢 Cruise Pulse',
  badgeDirect:      '📡 Direct from Cruise Lines',
  badgeLife:        '🌴 Cruise Life',
};

function normalizeStory(story = {}) {
  return {
    id: story.id || '',
    title: story.title || 'Untitled Story',
    source: Array.isArray(story.sources)
      ? story.sources[0]
      : story.source || 'Still Afloat AI',
    description:
      story.summary ||
      story.travelerImpact ||
      story.editorialReasoning ||
      '',
    link: story.originalLink || story.link || '',
    image: story.image || '',
    category: story.category || 'Cruise News',
    impactLevel: story.impactLevel || 'standard',
    travelerImpact: story.travelerImpact || '',
    publishedAt: story.approvedAt || story.generatedAt || '',
    tier:
      story.featured ||
      String(story.impactLevel || '').toLowerCase().includes('high')
        ? 'impact'
        : 'industry'
  };
}

function storyUrl(story) {
  const params = new URLSearchParams({
    id: story.id || '',
    title: story.title || '',
    source: story.source || '',
    description: story.description || '',
    link: story.link || '',
    image: story.image || '',
    category: story.category || '',
    published: story.publishedAt || ''
  });

  return `story.html?${params.toString()}`;
}

function badgeConfig(tier='lifestyle') {
  if (tier === 'impact') {
    return {
      label: L.badgeImpact,
      style: 'background:rgba(255,77,109,.18);color:#ffd5dd;border:1px solid rgba(255,77,109,.34);'
    };
  }

  if (tier === 'industry') {
    return {
      label: L.badgePulse,
      style: 'background:rgba(67,97,238,.18);color:#d8e2ff;border:1px solid rgba(67,97,238,.34);'
    };
  }

  if (tier === 'direct') {
    return {
      label: L.badgeDirect,
      style: 'background:rgba(93,255,154,.18);color:#d7ffe6;border:1px solid rgba(93,255,154,.34);'
    };
  }

  return {
    label: L.badgeLife,
    style: 'background:rgba(0,180,216,.18);color:#bff6ff;border:1px solid rgba(0,180,216,.34);'
  };
}

function renderHomepage(stories = []) {
  if (!homepageContainer) return;

  if (!stories.length) {
    homepageContainer.innerHTML = `<div style="padding:16px 0;color:white;font-weight:700;">${L.noStoriesHome}</div>`;
    return;
  }

  homepageContainer.innerHTML = stories.map(story => {
    const badge = badgeConfig(story.tier);

    return `
      <div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.12);">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
          <span style="${badge.style}padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.03em;backdrop-filter:blur(8px);">
            ${badge.label}
          </span>

          <span style="color:rgba(255,255,255,.62);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">
            ${story.source}
          </span>
        </div>

        <a
          href="${storyUrl(story)}"
          style="font-size:16px;font-weight:700;color:white;text-decoration:none;line-height:1.35;display:block;transition:all .18s ease;"
          onmouseover="this.style.color='#5dff9a';this.style.transform='translateX(4px)'"
          onmouseout="this.style.color='white';this.style.transform='translateX(0px)'"
        >
          ${story.title}
        </a>
      </div>
    `;
  }).join('');
}

function storyCard(story) {
  const badge = badgeConfig(story.tier);

  return `
    <article
      class="report-box"
      style="
        padding:20px 22px;
        border-radius:22px;
        background:rgba(210,230,255,0.10);
        backdrop-filter:blur(14px);
        border:1px solid rgba(255,255,255,.08);
        box-shadow:0 8px 22px rgba(0,0,0,.16);
        transition:all .2s ease;
      "
    >
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span style="${badge.style}padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.03em;backdrop-filter:blur(8px);">
            ${badge.label}
          </span>

          <span style="font-size:11px;font-weight:800;color:rgba(255,255,255,.62);text-transform:uppercase;letter-spacing:.05em;">
            ${story.source}
          </span>
        </div>

        ${story.publishedAt ? `
          <span style="font-size:11px;color:rgba(255,255,255,.52);font-weight:700;">
            ${new Date(story.publishedAt).toLocaleDateString(isSpanish ? 'es-419' : 'en-US')}
          </span>
        ` : ''}
      </div>

      <h3 style="font-size:22px;line-height:1.28;margin:0 0 10px;color:white;">
        ${story.title}
      </h3>

      <p style="line-height:1.55;color:rgba(255,255,255,.76);margin-bottom:16px;font-size:15px;">
        ${story.description || ''}
      </p>

      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
        <a
          href="${storyUrl(story)}"
          style="display:inline-block;color:#7de3ff;font-weight:800;text-decoration:none;font-size:14px;"
        >
          ${L.openDetail}
        </a>
      </div>
    </article>
  `;
}

function renderNewsBatch() {
  if (!fullNewsFeed) return;

  const nextStories = allStories.slice(renderedCount, renderedCount + STORIES_PER_BATCH);
  renderedCount += nextStories.length;

  const storyMarkup = nextStories.map(storyCard).join('');

  const grid = document.getElementById('news-story-grid');

  if (grid) {
    grid.insertAdjacentHTML('beforeend', storyMarkup);
  }

  const loadMoreButton = document.getElementById('load-more-news');

  if (loadMoreButton) {
    loadMoreButton.style.display = renderedCount >= allStories.length ? 'none' : 'inline-flex';
  }
}

function renderNewsPage(stories = []) {
  if (!fullNewsFeed) return;

  allStories = stories;
  renderedCount = 0;

  if (!stories.length) {
    fullNewsFeed.innerHTML = `<div class="report-box" style="padding:18px;border-radius:18px;background:rgba(255,255,255,0.10);backdrop-filter:blur(10px);color:white;">${L.noStoriesFull}</div>`;
    return;
  }

  fullNewsFeed.innerHTML = `
    <div style="margin-bottom:22px;display:flex;justify-content:space-between;gap:12px;align-items:flex-end;flex-wrap:wrap;">
      <div>
        <p style="color:#5dff9a;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px;">${L.liveIntel}</p>
        <h1 style="color:white;font-size:42px;line-height:1.1;margin:0;">${L.headlineFeed}</h1>
      </div>

      <div style="color:rgba(255,255,255,.62);font-weight:700;">
        ${L.storiesLoaded(stories.length)}
      </div>
    </div>

    <div id="news-story-grid" style="display:grid;gap:16px;"></div>

    <div style="display:flex;justify-content:center;margin-top:28px;">
      <button
        id="load-more-news"
        style="
          display:inline-flex;
          align-items:center;
          gap:10px;
          background:linear-gradient(180deg, rgba(9,72,117,.96), rgba(4,33,66,.96));
          color:white;
          border:none;
          border-radius:20px;
          padding:16px 28px;
          font-size:15px;
          font-weight:800;
          cursor:pointer;
          box-shadow:0 12px 28px rgba(0,0,0,.28);
        "
      >
        ${L.loadMore}
      </button>
    </div>
  `;

  renderNewsBatch();

  const loadMoreButton = document.getElementById('load-more-news');

  if (loadMoreButton) {
    loadMoreButton.addEventListener('click', renderNewsBatch);
  }
}

async function initNews() {
  try {
    const langParam = isSpanish ? '?lang=es' : '';
    const [homepageResponse, newsResponse] = await Promise.all([
      fetch(`${AGENT_BASE_URL}/api/homepage-feed${langParam}`),
      fetch(`${AGENT_BASE_URL}/api/news-feed${langParam}`)
    ]);

    const homepageData = await homepageResponse.json();
    const newsData = await newsResponse.json();

    const homepageStories = Array.isArray(homepageData.stories)
      ? homepageData.stories.map(normalizeStory)
      : [];

    const newsStories = Array.isArray(newsData.stories)
      ? newsData.stories.map(normalizeStory)
      : [];

    renderHomepage(homepageStories);
    renderNewsPage(newsStories);
  } catch (error) {
    console.error('News feed failed', error);

    if (fullNewsFeed) {
      fullNewsFeed.innerHTML = `
        <div style="padding:22px;border-radius:22px;background:rgba(255,255,255,.08);color:white;">
          ${L.loadError}
        </div>
      `;
    }
  }
}

initNews();
