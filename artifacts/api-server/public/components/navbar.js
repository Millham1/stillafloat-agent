// Still Afloat — Global Site Nav
// Injects logo (top-left) + glass-navy pill nav (top-right) as position:absolute
// within whichever parent has position:relative (the hero or banner section).
(function () {

  const isHome = ['', '/', '/index.html', 'index.html'].some(s =>
    window.location.pathname.endsWith(s) || window.location.pathname === s
  );

  const navHTML = `
    ${isHome ? '' : `
    <a class="sa-logo-home" href="index.html" title="Still Afloat Home">
      <img src="/assets/images/still_afloat_logo.png" alt="Still Afloat" class="sa-logo-img">
    </a>`}
    <nav class="sa-site-nav" id="saSiteNav">
      <div class="sa-nav-row">
        <a href="index.html"     class="sa-nav-link">Home</a>
        <a href="news.html"      class="sa-nav-link">Cruise News</a>
        <a href="weather.html"   class="sa-nav-link">Weather</a>
        <a href="affiliate.html" class="sa-nav-link">Gear</a>
      </div>
      <div class="sa-nav-row sa-secondary">
        <a href="under-construction.html" class="sa-nav-link">Book a Cruise</a>
      </div>
    </nav>
  `;

  const navCSS = `
    /* navbar-container fills its positioned parent (the hero/banner section) */
    #navbar-container {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 10;
    }
    #navbar-container > * { pointer-events: auto; }

    /* Logo — top-left of the banner */
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

    /* Nav pill — top-right, matches original homepage hero-nav style */
    .sa-site-nav {
      position: absolute;
      top: 22px;
      right: 22px;
      z-index: 20;
      width: fit-content;
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

    .sa-nav-row { display: flex; gap: 6px; justify-content: flex-end; }
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

    /* Shared reveal animation */
    .reveal {
      opacity: 0;
      transform: translateY(24px);
      transition: opacity .6s cubic-bezier(.22,1,.36,1), transform .6s cubic-bezier(.22,1,.36,1);
    }
    .reveal.visible { opacity: 1; transform: none; }

    /* Brand text spans — kept as fallback */
    .sa-still  { font-family: Pacifico, cursive; color: #FFD300; text-shadow: 0 2px 8px rgba(255,211,0,.30); }
    .sa-afloat { font-family: Pacifico, cursive; color: #6DCFFF; text-shadow: 0 2px 8px rgba(109,207,255,.28); }

    /* Brand logo images — inline sizing */
    .brand-img    { height: 2.4em; vertical-align: middle; display: inline-block; }
    .brand-img-sm { height: 1.4em; vertical-align: middle; display: inline-block; }
  `;

  const style = document.createElement('style');
  style.textContent = navCSS;
  document.head.appendChild(style);

  function injectNav() {
    const container = document.getElementById('navbar-container');
    if (!container) return;
    container.innerHTML = navHTML;

    // Active page highlight
    const current = window.location.pathname.split('/').pop() || 'index.html';
    container.querySelectorAll('.sa-nav-link').forEach(a => {
      const href = (a.getAttribute('href') || '').split('/').pop();
      if (href && href === current) a.classList.add('active');
    });

    // Scroll reveal observer
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
