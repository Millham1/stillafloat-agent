// Still Afloat Global Navbar Component
(function () {
  const navbarHTML = `
    <header class="sa-navbar">
      <div class="sa-navbar-inner">
        <a href="/index.html" class="sa-logo-wrap">
          <img src="/assets/images/still_afloat_logo.png" alt="Still Afloat" class="sa-logo" />
        </a>

        <nav class="sa-nav-links" id="saNavLinks">
          <a href="/index.html" class="sa-nav-link">Home</a>
          <a href="/news.html" class="sa-nav-link">Cruise News</a>
          <a href="/gear.html" class="sa-nav-link">Cruising Gear</a>
          <a href="#" class="sa-nav-link">Friday AI</a>
        </nav>

        <button class="sa-mobile-toggle" id="saMobileToggle" aria-label="Toggle Navigation">
          <span></span>
          <span></span>
          <span></span>
        </button>
      </div>
    </header>
  `;

  const navbarStyles = `
    .sa-navbar {
      position: sticky;
      top: 0;
      z-index: 1000;
      width: 100%;
      padding: 18px 28px;
      backdrop-filter: blur(18px);
      background: rgba(4, 12, 24, 0.72);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 10px 40px rgba(0,0,0,0.25);
    }

    .sa-navbar-inner {
      max-width: 1480px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .sa-logo {
      width: 220px;
      filter: drop-shadow(0 8px 20px rgba(0,0,0,0.45));
    }

    .sa-nav-links {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .sa-nav-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 14px 22px;
      border-radius: 999px;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      color: #ffffff;
      background: rgba(10, 31, 56, 0.72);
      border: 1px solid rgba(110, 208, 255, 0.18);
      box-shadow: 0 8px 20px rgba(0,0,0,0.22);
      transition: all 0.2s ease;
    }

    .sa-nav-link:hover {
      transform: translateY(-2px);
      background: rgba(14, 52, 90, 0.92);
      border-color: rgba(110, 208, 255, 0.42);
    }

    .sa-nav-link.active {
      background: linear-gradient(180deg, rgba(22, 88, 148, 0.96), rgba(8, 36, 64, 0.96));
      border-color: rgba(126, 219, 255, 0.5);
    }

    .sa-mobile-toggle {
      display: none;
    }

    @media (max-width: 920px) {
      .sa-mobile-toggle {
        display: flex;
        flex-direction: column;
        gap: 5px;
        background: rgba(8, 24, 44, 0.88);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        padding: 12px;
      }

      .sa-mobile-toggle span {
        width: 24px;
        height: 3px;
        border-radius: 999px;
        background: white;
      }

      .sa-nav-links {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        display: none;
        flex-direction: column;
        gap: 12px;
        padding: 20px;
        background: rgba(4, 12, 24, 0.96);
      }

      .sa-nav-links.open {
        display: flex;
      }
    }
  `;

  const styleElement = document.createElement('style');
  styleElement.innerHTML = navbarStyles;
  document.head.appendChild(styleElement);

  function injectNavbar() {
    const target = document.getElementById('navbar-container');

    if (!target) return;

    target.innerHTML = navbarHTML;

    const currentPage = window.location.pathname.split('/').pop();
    const links = target.querySelectorAll('.sa-nav-link');

    links.forEach(link => {
      const href = link.getAttribute('href');
      if (href && currentPage && href.includes(currentPage)) {
        link.classList.add('active');
      }
    });

    const toggle = document.getElementById('saMobileToggle');
    const navLinks = document.getElementById('saNavLinks');

    if (toggle && navLinks) {
      toggle.addEventListener('click', () => {
        navLinks.classList.toggle('open');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNavbar);
  } else {
    injectNavbar();
  }
})();