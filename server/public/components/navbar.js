// Still Afloat — Global Site Nav
// Auto-detects English vs Spanish pages (/es/*) and adjusts accordingly.
// Hamburger menu on mobile. Language switcher pill below nav on desktop.
(function () {

  const path     = window.location.pathname;
  const isSpanish = path.startsWith('/es/') || path === '/es';

  const isHome = isSpanish
    ? (path === '/es/' || path === '/es' || path.endsWith('/es/index.html'))
    : (['', '/', '/index.html', 'index.html'].some(s => path.endsWith(s) || path === s));

  const homeUrl  = isSpanish ? '/es/index.html' : '/index.html';
  // Compute equivalent page URL in the other language
  // Handles /es, /es/, /es/index.html, /es/news.html correctly
  // Pages that have a Spanish (/es/) counterpart
  const ES_PAGES = new Set(['index.html', 'news.html', 'weather.html', 'webcams.html', 'wheres-my-ship.html', 'room-concierge.html', 'cabin-request.html', 'affiliate.html', 'story.html', 'commentary.html', 'commentary-post.html', 'work-with-mark.html']);
  let langUrl;
  if (isSpanish) {
    let eng = path.replace(/^\/es(\/.*)?$/, (_m, rest) => rest || '/index.html');
    if (eng === '/' || eng === '') eng = '/index.html';
    langUrl = eng;
  } else {
    const file = (path.split('/').pop()) || 'index.html';
    // Fall back to /es/index.html for pages without a Spanish counterpart
    const esFile = ES_PAGES.has(file) ? file : 'index.html';
    langUrl = '/es/' + esFile;
  }
  // Preserve query string (e.g. ?id=... on story pages) when switching languages
  langUrl = langUrl + window.location.search;
  const langLabel = isSpanish ? '🇺🇸 English' : '🌎 En Español';

  // ── Language auto-routing (Mark, 2026-08-29) ──
  // A Spanish-preference browser landing on an EN page gets the ES twin
  // automatically — but only once: the redirect stores a preference, and using
  // the language switcher stores an explicit one, so a deliberate choice of
  // either language always sticks. Pages without an ES twin never redirect.
  const LANG_PREF_KEY = 'sa_lang_pref';
  let langPref = null;
  try { langPref = localStorage.getItem(LANG_PREF_KEY); } catch { /* storage blocked → detect-only */ }
  function rememberLang(lang) {
    try { localStorage.setItem(LANG_PREF_KEY, lang); } catch { /* best-effort */ }
  }
  if (!isSpanish && langPref !== 'en') {
    // Route to ES when the reader has chosen ES (stored pref) OR has no stored
    // choice and their browser prefers Spanish. This keeps working on EVERY
    // EN-page landing (bookmarks, search results, shared links) — only an
    // explicit English choice ('en' pref, via the switcher) turns it off.
    const browserLangs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    const prefersEs = langPref === 'es' || browserLangs.some(l => String(l).toLowerCase().startsWith('es'));
    const file = (path.split('/').pop()) || 'index.html';
    const esTwin = ES_PAGES.has(file) ? file : (path === '/' || path === '' ? 'index.html' : null);
    if (prefersEs && esTwin) {
      rememberLang('es');
      window.location.replace('/es/' + esTwin + window.location.search);
    }
  }

  // ── Nav links (absolute paths) ──
  const mainLinks = isSpanish ? [
    { href: '/es/index.html',          label: 'Inicio'       },
    { href: '/es/news.html',           label: 'Noticias'     },
    { href: '/es/weather.html',        label: 'Clima'        },
    { href: '/es/webcams.html',        label: 'Cámaras'      },
    { href: '/es/wheres-my-ship.html', label: 'Mi Barco'     },
    { href: '/es/room-concierge.html', label: 'Concierge'    },
    { href: '/favorites.html',         label: 'Favoritos'    },
    { href: '/es/commentary.html',     label: 'Comentarios'  },
    { href: '/es/affiliate.html',      label: 'Equipo'       },
  ] : [
    { href: '/index.html',         label: 'Home'        },
    { href: '/news.html',          label: 'Cruise News'  },
    { href: '/weather.html',       label: 'Weather'      },
    { href: '/webcams.html',       label: 'Live Streams' },
    { href: '/wheres-my-ship.html',label: "Where's My Ship?" },
    { href: '/room-concierge.html',label: 'Room Concierge' },
    { href: '/favorites.html',     label: 'Favorites'    },
    { href: '/commentary.html',    label: 'Commentary'  },
    { href: '/affiliate.html',     label: 'Gear'        },
  ];

  const bookLabel = isSpanish ? 'Trabaja Con Mark' : 'Work With Mark';
  const bookUrl   = isSpanish ? '/es/work-with-mark.html' : '/work-with-mark.html';
  const subscribeUrl       = isSpanish ? '/es/subscribe.html' : '/subscribe.html';
  const subscribeLabel     = isSpanish ? '✉ Suscríbete'       : '✉ Subscribe';
  const subscribeLabelFull = isSpanish ? '✉ Suscríbete gratis' : '✉ Subscribe Free';

  // ── Homepage quick-action pills (Mark, 2026-08-31) ──
  // Two standout pills flanking the nav block, HOME ONLY: Room Concierge left,
  // Cruise Gear right. Home is the only page without the corner logo, so the
  // left slot is free there and nowhere else — hence the isHome gate.
  const conciergePill = isSpanish
    ? { href: '/es/room-concierge.html', label: 'Concierge de Camarotes', cta: 'Encuentra tu camarote →', title: 'Concierge de Camarotes — gratis' }
    : { href: '/room-concierge.html', label: 'Room Concierge', cta: 'Find my cabin →', title: 'Room Concierge — free cabin match' };
  const gearPill = isSpanish
    ? { href: '/es/affiliate.html', label: 'Equipo de Crucero', cta: 'Ver el equipo →', title: 'Equipo probado en el mar' }
    : { href: '/affiliate.html', label: 'Cruise Gear', cta: 'See the gear →', title: 'Gear tested at sea' };
  const homePillsHTML = isHome ? `
    <a class="sa-quick-pill sa-quick-left" href="${conciergePill.href}" title="${conciergePill.title}">
      <span class="sa-quick-title"><i class="fa-solid fa-bed"></i>${conciergePill.label}</span>
      <span class="sa-quick-cta">${conciergePill.cta}</span>
    </a>
    <a class="sa-quick-pill sa-quick-right" href="${gearPill.href}" title="${gearPill.title}">
      <span class="sa-quick-title"><i class="fa-solid fa-suitcase-rolling"></i>${gearPill.label}</span>
      <span class="sa-quick-cta">${gearPill.cta}</span>
    </a>` : '';

  const navHTML = `
    ${homePillsHTML}
    ${isHome ? '' : `
    <a class="sa-logo-home" href="${homeUrl}" title="Still Afloat Home">
      <img src="/assets/images/still_afloat_logo.png" alt="Still Afloat" class="sa-logo-img">
    </a>`}
    <nav class="sa-site-nav" id="saSiteNav">
      <div class="sa-nav-row">
        ${mainLinks.slice(0, 6).map(l => `<a href="${l.href}" class="sa-nav-link">${l.label}</a>`).join('')}
      </div>
      <div class="sa-nav-row sa-secondary">
        ${mainLinks.slice(6).map(l => `<a href="${l.href}" class="sa-nav-link">${l.label}</a>`).join('')}
        <a href="${bookUrl}" class="sa-nav-link">${bookLabel}</a>
        <a href="${subscribeUrl}" class="sa-nav-link sa-subscribe-link">${subscribeLabel}</a>
        <a href="${langUrl}" class="sa-nav-link sa-lang-link" title="${langLabel}">${langLabel}</a>
      </div>
    </nav>
    <button class="sa-hamburger" aria-label="Open menu" aria-expanded="false">
      <i class="fa-solid fa-bars"></i>
    </button>
  `;

  const mobileMenuHTML = `
    <div class="sa-mobile-menu" id="saMobileMenu">
      <button class="sa-mobile-close" aria-label="Close menu">
        <i class="fa-solid fa-xmark"></i>
      </button>
      ${mainLinks.map(l => `<a href="${l.href}" class="sa-mobile-link">${l.label}</a>`).join('')}
      <a href="${bookUrl}" class="sa-mobile-link">${bookLabel}</a>
      <a href="${subscribeUrl}" class="sa-mobile-link sa-mobile-subscribe">${subscribeLabelFull}</a>
      <div class="sa-mobile-lang-divider"></div>
      <a href="${langUrl}" class="sa-mobile-link sa-mobile-lang">${langLabel}</a>
    </div>
    <div class="sa-mobile-overlay" id="saMobileOverlay"></div>
  `;

  const navCSS = `
    #navbar-container {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 10;
    }
    /* Reserve vertical space for the (absolutely-positioned) nav on whatever element
       hosts it, so the bar is a consistent top strip and never overlaps page content.
       Padding works for BOTH block and flex hosts (unlike making the container itself
       reserve height, which collapses to 0 width inside a flex hero). */
    .sa-navbar-host { padding-top: 132px; }
    #navbar-container > * { pointer-events: auto; }

    .sa-logo-home {
      position: absolute;
      top: 18px;
      left: 22px;
      z-index: 20;
      text-decoration: none;
      display: inline-flex;
    }
    .sa-logo-img {
      height: 90px;
      width: auto;
      filter: drop-shadow(0 6px 18px rgba(0,0,0,0.60));
      transition: transform .22s ease;
    }
    .sa-logo-home:hover .sa-logo-img { transform: scale(1.05); }

    /* ── Desktop nav pill ── */
    .sa-site-nav {
      position: absolute;
      top: 22px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      /* fit-content under-resolved on this absolutely-centered wrap container and
         orphaned one pill per row ("Room Concierge", "En Español" each alone —
         Mark, 2026-08-21). max-content lays each row out whole; the cap still
         lets narrow screens wrap before the hamburger takes over. */
      width: max-content;
      max-width: min(96vw, 1100px);
      display: flex;
      flex-direction: column;
      gap: 5px;
      background: linear-gradient(180deg, rgba(9,72,117,.96), rgba(4,33,66,.96));
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(123,214,255,.32);
      border-radius: 24px;
      padding: 10px 14px;
      box-shadow:
        0 18px 40px rgba(0,0,0,.38),
        inset 0 1px 0 rgba(255,255,255,.18),
        inset 0 -1px 0 rgba(0,0,0,.24);
    }
    .sa-site-nav::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 24px;
      padding: 1px;
      background: linear-gradient(135deg, rgba(125,225,255,.38), rgba(255,255,255,.06));
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
    }

    .sa-nav-row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
    .sa-nav-row.sa-secondary {
      border-top: 1px solid rgba(255,255,255,.14);
      padding-top: 5px;
      justify-content: center;
    }

    .sa-nav-link {
      display: inline-block;
      font-size: 13px;
      font-weight: 700;
      padding: 8px 14px;
      border-radius: 14px;
      color: #ffffff;
      text-decoration: none;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.08);
      transition: all .2s ease;
      text-shadow: 0 1px 4px rgba(0,0,0,.3);
      white-space: nowrap;
      letter-spacing: .2px;
    }
    .sa-nav-link:hover {
      background: rgba(93,255,154,.16);
      border-color: rgba(93,255,154,.32);
      color: #5dff9a;
      transform: translateY(-1px);
      text-shadow: 0 0 10px rgba(93,255,154,.4);
    }
    .sa-nav-link.active {
      background: rgba(0,119,182,.32);
      border-color: rgba(93,255,154,.28);
      color: #5dff9a;
    }

    /* ── Subscribe CTA ── */
    .sa-subscribe-link {
      background: linear-gradient(135deg, rgba(93,255,154,.18), rgba(93,255,154,.08)) !important;
      border-color: rgba(93,255,154,.45) !important;
      color: #5dff9a !important;
      font-weight: 900 !important;
      letter-spacing: .02em;
    }
    .sa-subscribe-link:hover {
      background: linear-gradient(135deg, rgba(93,255,154,.30), rgba(93,255,154,.15)) !important;
      border-color: #5dff9a !important;
      box-shadow: 0 0 16px rgba(93,255,154,.25) !important;
    }

    /* ── Language switcher — lives inside the nav pill ── */
    .sa-lang-link {
      background: rgba(93,255,154,.10) !important;
      border-color: rgba(93,255,154,.35) !important;
      color: #5dff9a !important;
    }
    .sa-lang-link:hover {
      background: rgba(93,255,154,.22) !important;
      border-color: rgba(93,255,154,.60) !important;
      color: #5dff9a !important;
    }

    /* ── Homepage quick-action pills (flank the nav block; home only) ── */
    .sa-quick-pill {
      position: absolute;
      top: 30px;
      z-index: 20;
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 16px 22px 15px;
      border-radius: 22px;
      white-space: nowrap;
      text-decoration: none;
      background: linear-gradient(180deg, rgba(9,72,117,.96), rgba(4,33,66,.96));
      border: 1px solid rgba(93,255,154,.45);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 12px 28px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.16);
      transition: all .22s ease;
    }
    .sa-quick-title {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: #ffffff;
      font-size: 17px;
      font-weight: 900;
      letter-spacing: .02em;
      text-shadow: 0 1px 6px rgba(0,0,0,.35);
    }
    .sa-quick-title i { font-size: 18px; color: #5dff9a; filter: drop-shadow(0 0 8px rgba(93,255,154,.35)); }
    .sa-quick-cta {
      color: #5dff9a;
      font-size: 15px;
      font-weight: 800;
      letter-spacing: .02em;
      text-shadow: 0 0 10px rgba(93,255,154,.30);
    }
    .sa-quick-pill:hover {
      transform: translateY(-2px);
      border-color: #5dff9a;
      background: linear-gradient(180deg, rgba(0,119,182,.96), rgba(4,33,66,.96));
      box-shadow: 0 16px 34px rgba(0,0,0,.44), 0 0 18px rgba(93,255,154,.28);
    }
    .sa-quick-left  { left: 2.5vw; }
    .sa-quick-right { right: 2.5vw; }
    /* Mid widths: the centered nav block leaves no safe flanking room — the same
       links live inside the nav, so the pills bow out rather than overlap. */
    @media (max-width: 991px) { .sa-quick-pill { display: none; } }
    /* Mobile: nav collapses to the hamburger (top-right), which frees the left
       side of the reserved strip — the pills stack there, compact. */
    @media (max-width: 768px) {
      .sa-quick-pill { display: flex; padding: 11px 16px 10px; gap: 3px; }
      .sa-quick-title { font-size: 14px; }
      .sa-quick-title i { font-size: 15px; }
      .sa-quick-cta { font-size: 12.5px; }
      .sa-quick-left  { left: 14px; top: 12px; }
      .sa-quick-right { left: 14px; right: auto; top: 76px; }
    }

    /* ── Hamburger button ── */
    .sa-hamburger {
      display: none;
      position: absolute;
      top: 14px;
      right: 14px;
      z-index: 30;
      background: linear-gradient(180deg, rgba(9,72,117,.96), rgba(4,33,66,.96));
      border: 1px solid rgba(123,214,255,.32);
      border-radius: 16px;
      padding: 12px 18px;
      cursor: pointer;
      color: white;
      font-size: 22px;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 8px 24px rgba(0,0,0,.40);
      align-items: center;
      line-height: 1;
    }
    .sa-hamburger:active { transform: scale(0.96); }

    /* ── Mobile slide-down menu ── */
    .sa-mobile-menu {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 9999;
      background: linear-gradient(180deg, rgba(4,17,46,.98) 0%, rgba(7,30,70,.98) 100%);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-bottom: 1px solid rgba(123,214,255,.22);
      border-radius: 0 0 28px 28px;
      padding: 72px 20px 28px;
      /* The menu can be taller than a phone screen (12 links) and body scroll is
         locked while it's open — the menu itself must scroll or the bottom links
         (Gear, ES) are unreachable. dvh keeps the cap honest under mobile
         browser chrome; vh is the fallback for older WebKit. */
      box-sizing: border-box; /* padding must count toward the cap or it pokes below the fold */
      max-height: 100vh;
      max-height: 100dvh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      box-shadow: 0 28px 60px rgba(0,0,0,.60);
      transform: translateY(-110%);
      transition: transform 0.34s cubic-bezier(.22,1,.36,1);
      pointer-events: none;
    }
    .sa-mobile-menu.open {
      transform: translateY(0);
      pointer-events: auto;
    }

    .sa-mobile-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.52);
      z-index: 9998;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    }
    .sa-mobile-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }

    .sa-mobile-close {
      position: absolute;
      top: 16px;
      right: 16px;
      background: rgba(255,255,255,.10);
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 50%;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: white;
      font-size: 18px;
      transition: background .2s ease;
    }
    .sa-mobile-close:hover { background: rgba(255,255,255,.18); }

    .sa-mobile-link {
      display: flex;
      align-items: center;
      padding: 15px 20px;
      color: white;
      font-family: 'Baloo 2', system-ui, sans-serif;
      font-size: 19px;
      font-weight: 700;
      border-radius: 16px;
      margin-bottom: 8px;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.05);
      text-decoration: none;
      transition: all .2s ease;
      min-height: 48px;
    }
    .sa-mobile-link:hover,
    .sa-mobile-link:active {
      background: rgba(93,255,154,.14);
      border-color: rgba(93,255,154,.30);
      color: #5dff9a;
    }

    .sa-mobile-lang-divider {
      height: 1px;
      background: rgba(93,255,154,.22);
      margin: 8px 4px 16px;
    }

    .sa-mobile-lang {
      background: rgba(93,255,154,.10);
      border-color: rgba(93,255,154,.30);
      color: #5dff9a;
      font-size: 17px;
    }
    .sa-mobile-lang:hover,
    .sa-mobile-lang:active {
      background: rgba(93,255,154,.22);
    }

    .sa-mobile-subscribe {
      background: rgba(93,255,154,.12);
      border-color: rgba(93,255,154,.35);
      color: #5dff9a;
      font-weight: 900;
    }
    .sa-mobile-subscribe:hover,
    .sa-mobile-subscribe:active {
      background: rgba(93,255,154,.22);
    }

    /* Reveal animation */
    .reveal {
      opacity: 0;
      transform: translateY(24px);
      transition: opacity .6s cubic-bezier(.22,1,.36,1), transform .6s cubic-bezier(.22,1,.36,1);
    }
    .reveal.visible { opacity: 1; transform: none; }

    .sa-still  { font-family: Pacifico, cursive; color: #FFD300; text-shadow: 0 2px 8px rgba(255,211,0,.30); }
    .sa-afloat { font-family: Pacifico, cursive; color: #6DCFFF; text-shadow: 0 2px 8px rgba(109,207,255,.28); }

    .brand-img    { height: 44px;  width: auto; vertical-align: middle; display: inline-block; }
    .brand-img-sm { height: 30px;  width: auto; vertical-align: middle; display: inline-block; }

    /* ── Mobile breakpoint ── */
    @media (max-width: 768px) {
      .sa-navbar-host { padding-top: 90px; }
      .sa-site-nav  { display: none; }
      .sa-lang-pill { display: none; }
      .sa-hamburger { display: flex; }
      .sa-logo-img  { height: 60px; }
    }
  `;

  const style = document.createElement('style');
  style.textContent = navCSS;
  document.head.appendChild(style);

  const mobileWrap = document.createElement('div');
  mobileWrap.innerHTML = mobileMenuHTML;
  document.body.appendChild(mobileWrap);

  function injectNav() {
    const container = document.getElementById('navbar-container');
    if (!container) return;
    if (container.parentElement) container.parentElement.classList.add('sa-navbar-host');
    container.innerHTML = navHTML;

    // Active page highlight — normalize both sides so /index.html, /, and '' all match
    function normPath(p) {
      return p.replace(/\/index\.html$/, '/').replace(/\/$/, '') || '/';
    }
    const normCurrent = normPath(path);
    container.querySelectorAll('.sa-nav-link').forEach(a => {
      if (normPath(a.getAttribute('href') || '') === normCurrent) a.classList.add('active');
    });

    // Hamburger toggle
    const hamburger  = container.querySelector('.sa-hamburger');
    const mobileMenu = document.getElementById('saMobileMenu');
    const overlay    = document.getElementById('saMobileOverlay');
    const closeBtn   = mobileMenu && mobileMenu.querySelector('.sa-mobile-close');

    function openMenu() {
      if (!mobileMenu || !overlay) return;
      mobileMenu.classList.add('open');
      overlay.classList.add('open');
      hamburger && hamburger.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
    }
    function closeMenu() {
      if (!mobileMenu || !overlay) return;
      mobileMenu.classList.remove('open');
      overlay.classList.remove('open');
      hamburger && hamburger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }

    if (hamburger) hamburger.addEventListener('click', openMenu);
    if (closeBtn)  closeBtn.addEventListener('click', closeMenu);
    if (overlay)   overlay.addEventListener('click', closeMenu);
    document.querySelectorAll('.sa-mobile-link').forEach(l =>
      l.addEventListener('click', closeMenu)
    );

    // Using the switcher is an explicit language choice — it overrides the
    // browser-language auto-redirect from then on, in both directions.
    document.querySelectorAll('.sa-lang-link, .sa-mobile-lang').forEach(l =>
      l.addEventListener('click', () => rememberLang(isSpanish ? 'en' : 'es'))
    );

    // Scroll reveal
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
      });
    }, { threshold: 0.08 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNav);
  } else {
    injectNav();
  }
})();
