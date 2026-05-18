// Still Afloat Global Navbar Component
(function () {
  const navbarHTML = `
    <header class="sa-navbar">
      <div class="sa-navbar-inner">
        <a href="/index.html" class="sa-logo-wrap" title="Still Afloat Home">
          <img src="/assets/images/still_afloat_logo.png" alt="Still Afloat" class="sa-logo" />
        </a>

        <nav class="sa-nav-links" id="saNavLinks">
          <a href="/index.html"      class="sa-nav-link">🏠 Home</a>
          <a href="/news.html"       class="sa-nav-link">📰 Cruise News</a>
          <a href="/weather.html"    class="sa-nav-link">⛅ Weather</a>
          <a href="/affiliate.html"  class="sa-nav-link">🎒 Gear</a>
          <a href="#"                class="sa-nav-link">Book a Cruise</a>
        </nav>

        <button class="sa-mobile-toggle" id="saMobileToggle" aria-label="Toggle Navigation">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>
  `;

  const navbarStyles = `
    /* ── Navbar ── */
    .sa-navbar {
      position: sticky;
      top: 0;
      z-index: 1000;
      width: 100%;
      padding: 8px 20px;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      background: rgba(4, 12, 28, 0.88);
      border-bottom: 1px solid rgba(93,255,154,0.10);
      box-shadow: 0 8px 32px rgba(0,0,0,0.32);
    }

    .sa-navbar-inner {
      max-width: 1480px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .sa-logo-wrap { display: inline-flex; align-items: center; flex-shrink: 0; }
    .sa-logo { height: 42px; width: auto; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.5)); }

    .sa-nav-links { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }

    .sa-nav-link {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 8px 14px;
      border-radius: 999px;
      text-decoration: none;
      font-weight: 700;
      font-size: 13px;
      color: #ffffff;
      background: rgba(10, 28, 54, 0.65);
      border: 1px solid rgba(93,255,154,0.12);
      box-shadow: 0 4px 12px rgba(0,0,0,0.18);
      transition: all 0.22s ease;
      white-space: nowrap;
    }

    .sa-nav-link:hover {
      transform: translateY(-2px);
      background: rgba(0,119,182,0.72);
      border-color: rgba(93,255,154,0.38);
      color: #5dff9a;
      box-shadow: 0 8px 20px rgba(0,0,0,0.28);
    }

    .sa-nav-link.active {
      background: linear-gradient(180deg, rgba(0,119,182,0.92), rgba(4,24,52,0.92));
      border-color: rgba(93,255,154,0.42);
      color: #5dff9a;
    }

    .sa-mobile-toggle { display: none; }

    @media (max-width: 860px) {
      .sa-navbar { position: relative; }

      .sa-mobile-toggle {
        display: flex;
        flex-direction: column;
        gap: 5px;
        background: rgba(8,24,44,0.88);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        padding: 10px;
        cursor: pointer;
      }
      .sa-mobile-toggle span { width: 22px; height: 2px; border-radius: 999px; background: white; }

      .sa-nav-links {
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        flex-direction: column;
        gap: 8px;
        padding: 16px 20px;
        background: rgba(4,12,28,0.98);
        border-bottom: 1px solid rgba(93,255,154,0.10);
      }
      .sa-nav-links.open { display: flex; }
      .sa-nav-link { width: 100%; justify-content: flex-start; }
    }

    /* ── Brand text: "Still Afloat" / "Stay Afloat" ── */
    .sa-brand {
      display: inline;
      font-family: 'Baloo 2', 'Pacifico', cursive;
    }
    .sa-brand .sa-still {
      font-family: 'Pacifico', cursive;
      color: #ffca4f;
      text-shadow: 0 2px 8px rgba(255,202,79,0.35);
    }
    .sa-brand .sa-afloat {
      font-family: 'Pacifico', cursive;
      color: #5dff9a;
      text-shadow: 0 2px 8px rgba(93,255,154,0.28);
    }

    /* Variant for light backgrounds */
    .sa-brand-dark .sa-still  { color: #d4920a; text-shadow: none; }
    .sa-brand-dark .sa-afloat { color: #0077b6; text-shadow: none; }

    /* ── Reveal animations (used across all pages) ── */
    .reveal {
      opacity: 0;
      transform: translateY(28px);
      transition: opacity 0.65s cubic-bezier(0.22,1,0.36,1),
                  transform 0.65s cubic-bezier(0.22,1,0.36,1);
    }
    .reveal.visible {
      opacity: 1;
      transform: none;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.innerHTML = navbarStyles;
  document.head.appendChild(styleEl);

  function injectNavbar() {
    const target = document.getElementById('navbar-container');
    if (!target) return;

    target.innerHTML = navbarHTML;

    // Mark active link
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    target.querySelectorAll('.sa-nav-link').forEach(link => {
      const href = (link.getAttribute('href') || '').split('/').pop();
      if (href && href === currentPage) link.classList.add('active');
    });

    // Mobile toggle
    const toggle = document.getElementById('saMobileToggle');
    const navLinks = document.getElementById('saNavLinks');
    if (toggle && navLinks) {
      toggle.addEventListener('click', () => navLinks.classList.toggle('open'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNavbar);
  } else {
    injectNavbar();
  }

  // Shared IntersectionObserver for reveal animations
  document.addEventListener('DOMContentLoaded', () => {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  });
})();
