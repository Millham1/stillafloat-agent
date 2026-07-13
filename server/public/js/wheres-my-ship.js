// Where's My Ship? — shared page logic (EN + ES; strings come from the page's
// inline `T`/`LANG` globals).
//
// Funnel: the live map view is PUBLIC (the one-time peek is the hook). Only
// the save-a-watch flow (ongoing email updates) requires a confirmed
// subscriber — the backend enforces it (403 subscriber_required on save).
// Data: /api/wms/* and /api/weather?place= for the arrival-day weather card.
// Map: Leaflet over Esri World Imagery satellite tiles, with Esri's
// Boundaries & Places reference layer so land masses near the ship are named.
(function () {
  const $ = (id) => document.getElementById(id);

  let ships = [];
  let currentShip = null;
  let map = null, marker = null;
  let pollTimer = null;
  let lastWeatherSlug = null;

  const emailKey = 'wms_email';

  // ── Ship search ────────────────────────────────────────────────────────────
  async function loadShips() {
    try {
      const r = await fetch('/api/wms/ships');
      const d = await r.json();
      ships = (d.ships || []);
    } catch { ships = []; }
  }

  function shipItems(list) {
    return list.map((s) =>
      `<div class="d-item" data-ship="${s.name}"><span>${s.live ? '<span style="color:#5dff9a">●</span> ' : ''}${s.name}</span><small>${s.cruiseLine}</small></div>`
    ).join('');
  }

  function setupSearch() {
    const input = $('ship-input');
    const drop = $('ship-dropdown');

    function show(list) {
      drop.innerHTML = list.length ? shipItems(list)
        : `<div class="d-empty">${LANG === 'es' ? 'No encontramos ese barco todavía — vamos agregando más.' : "We don't track that one yet — more ships are coming aboard."}</div>`;
      drop.classList.add('open');
    }

    input.addEventListener('focus', () => show(ships));
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      show(!q ? ships : ships.filter((s) =>
        s.name.toLowerCase().includes(q) || s.cruiseLine.toLowerCase().includes(q)));
    });
    drop.addEventListener('click', (e) => {
      const item = e.target.closest('.d-item');
      if (!item) return;
      input.value = item.dataset.ship;
      drop.classList.remove('open');
      selectShip(item.dataset.ship);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!drop.contains(e.target) && e.target !== input) drop.classList.remove('open');
    });
  }

  // ── Map ────────────────────────────────────────────────────────────────────
  function ensureMap() {
    if (map) return;
    map = L.map('map', { worldCopyJump: true, zoomControl: true, scrollWheelZoom: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 17,
      attribution: 'Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics',
    }).addTo(map);
    // Reference labels (island, city, and country names) over the imagery so
    // people can tell what land the ship is near.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 17,
      pane: 'shadowPane', // above tiles, below markers
    }).addTo(map);
    map.setView([24.5, -80.5], 5);
  }

  function shipIcon(courseDeg) {
    // A small bright-green cruise ship (side profile) with a soft glow. Bow
    // faces the direction of travel: eastbound faces right, westbound flips.
    const westbound = Number.isFinite(courseDeg) && courseDeg > 180 && courseDeg < 360;
    return L.divIcon({
      className: '',
      iconSize: [52, 36],
      iconAnchor: [26, 22],
      html: `<div style="width:52px;height:36px;${westbound ? 'transform:scaleX(-1);' : ''}filter:drop-shadow(0 0 6px rgba(93,255,154,.95))">
        <svg viewBox="0 0 52 36" width="52" height="36">
          <g fill="#5dff9a" stroke="#04310f" stroke-width="1.2" stroke-linejoin="round">
            <path d="M3 24 L49 24 L43 33 L10 33 Z"/>
            <path d="M9 17 L40 17 L40 24 L9 24 Z"/>
            <path d="M14 10 L33 10 L33 17 L14 17 Z"/>
            <path d="M25 4 L30 4 L31 10 L24 10 Z"/>
          </g>
          <g fill="#04310f">
            <circle cx="15" cy="20.5" r="1.2"/><circle cx="20" cy="20.5" r="1.2"/>
            <circle cx="25" cy="20.5" r="1.2"/><circle cx="30" cy="20.5" r="1.2"/>
            <circle cx="35" cy="20.5" r="1.2"/>
            <circle cx="19" cy="13.5" r="1.2"/><circle cx="24" cy="13.5" r="1.2"/>
            <circle cx="29" cy="13.5" r="1.2"/>
          </g>
        </svg></div>`,
    });
  }

  // ── Info card ──────────────────────────────────────────────────────────────
  function compassName(deg) {
    return T.compass[Math.round(deg / 22.5) % 16];
  }

  function fmtEta(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString(LANG === 'es' ? 'es-419' : 'en-US',
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderInfo(d) {
    $('i-ship').textContent = d.ship;
    $('i-line').textContent = d.cruiseLine || '';
    const speed = d.speedKn;
    const moving = Number.isFinite(speed) && speed > 1;
    // Status makes sea days explicit — a two-day-old "departed" line on a
    // 3-day crossing is normal cruising, not a stale-data bug.
    const today = new Date().toISOString().slice(0, 10);
    const etaDate = d.etaUtc ? String(d.etaUtc).slice(0, 10) : '';
    $('i-status').textContent = !moving ? T.statusInPort
      : (etaDate && etaDate <= today ? T.statusArriving : T.statusSea);
    $('i-course').textContent = moving && Number.isFinite(d.courseDeg)
      ? `${Math.round(d.courseDeg)}° ${compassName(d.courseDeg)}` : T.inPort;
    $('i-speed').textContent = Number.isFinite(speed) ? `${speed.toFixed(1)} ${T.kn}` : '—';
    $('i-dest').textContent = d.destination ? d.destination.name : (d.destinationRaw || '—');
    $('i-eta').textContent = fmtEta(d.etaUtc);
    $('i-departed').textContent = d.departed
      ? `${d.departed.port} · ${fmtEta(d.departed.at)}` : '—';
    $('i-age').textContent = T.ago(d.lastReportedMinAgo);

    const banner = $('stale-banner');
    if (d.stale) {
      banner.innerHTML = T.stale(d.ship, T.ago(d.lastReportedMinAgo));
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }

    const pill = $('live-pill');
    pill.style.display = 'block';
    pill.classList.toggle('stale', Boolean(d.stale));
    $('live-pill-text').textContent = d.stale ? T.stalePill : T.livePill;
  }

  // ── Weather card: the destination port on the day the ship is expected ─────
  async function renderWeather(dest, etaUtc) {
    const card = $('wx-card');
    if (!dest || !dest.slug) { card.style.display = 'none'; lastWeatherSlug = null; return; }
    const etaDate = etaUtc ? String(etaUtc).slice(0, 10) : '';
    const cacheKey = `${dest.slug}|${etaDate}`;
    if (cacheKey === lastWeatherSlug) return; // already rendered
    try {
      const r = await fetch(`/api/weather?place=${dest.slug}`);
      const d = await r.json();
      if (!d.ok || !d.forecast) { card.style.display = 'none'; return; }
      const days = d.forecast.forecast || [];
      // Only the expected-arrival day (fall back to the first forecast day).
      const day = days.find((f) => f.day === etaDate) || days[0];
      if (!day) { card.style.display = 'none'; return; }
      lastWeatherSlug = cacheKey;
      $('wx-port').textContent = d.forecast.name;
      const longDay = new Date(day.day + 'T12:00:00').toLocaleDateString(
        LANG === 'es' ? 'es-419' : 'en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      $('wx-days').innerHTML = `
        <div class="wx-day big">
          <div class="d">${T.arrivalDay} · ${longDay}</div>
          <div class="e">${day.emoji}</div>
          <div class="t">${day.high}°<small>/${day.low}°</small></div>
        </div>`;
      $('wx-syn').textContent = d.forecast.synopsis || '';
      $('wx-more').href = `/forecast.html?place=${dest.slug}`;
      card.style.display = '';
    } catch { card.style.display = 'none'; }
  }

  // ── Tracking loop (public — no gate) ───────────────────────────────────────
  async function refresh(shipName) {
    const r = await fetch(`/api/wms/position?ship=${encodeURIComponent(shipName)}`);
    const d = await r.json();
    $('tracker').style.display = 'block'; // (''+stylesheet display:none stays hidden)

    if (!d.tracking) {
      $('i-ship').textContent = shipName;
      $('i-line').textContent = '';
      ['i-status','i-course','i-speed','i-dest','i-eta','i-departed','i-age'].forEach((id) => { $(id).textContent = '—'; });
      const banner = $('stale-banner');
      banner.innerHTML = d.reason === 'tracker_offline' ? T.trackerOffline
        : d.reason === 'waking' ? T.waking(shipName)
        : T.noSignal(shipName);
      banner.style.display = 'block';
      $('live-pill').style.display = 'none';
      $('wx-card').style.display = 'none';
      ensureMap();
      $('updated').textContent = '';
      // A waking ship reports within moments of the subscription update —
      // poll faster until she does.
      if (d.reason === 'waking') {
        clearInterval(pollTimer);
        pollTimer = setInterval(() => refresh(shipName).catch(() => {}), 20_000);
      }
      return;
    }

    renderInfo(d);
    ensureMap();
    const pos = [d.position.lat, d.position.lon];
    if (!marker) {
      marker = L.marker(pos, { icon: shipIcon(d.courseDeg) }).addTo(map);
      map.setView(pos, 8);
    } else {
      marker.setLatLng(pos);
      marker.setIcon(shipIcon(d.courseDeg));
      if (!map.getBounds().contains(pos)) map.setView(pos, map.getZoom());
    }
    marker.bindTooltip(d.ship, { direction: 'top', offset: [0, -20] });
    $('updated').textContent = new Date().toLocaleTimeString(LANG === 'es' ? 'es-419' : 'en-US');
    renderWeather(d.destination, d.etaUtc);
  }

  function startTracking(shipName) {
    currentShip = shipName;
    clearInterval(pollTimer);
    refresh(shipName).catch(() => {});
    pollTimer = setInterval(() => refresh(shipName).catch(() => {}), 60_000);
    $('tracker').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function selectShip(shipName) {
    // Wake the ship's tracking (stamps the request; retained in the scheduler).
    // Fire-and-forget: the position poll below reports the current state.
    fetch('/api/wms/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ship: shipName }),
    }).catch(() => {});
    startTracking(shipName);
  }

  // ── Watch CTA (the sale — subscriber-only, enforced server-side) ───────────
  function setupWatch() {
    $('watch-open').addEventListener('click', () => {
      $('w-email').value = localStorage.getItem(emailKey) || '';
      $('watch-form').style.display = 'block';
      $('watch-open').style.display = 'none';
    });
    $('watch-save').addEventListener('click', async () => {
      const err = $('watch-err');
      err.style.display = 'none';
      const email = $('w-email').value.trim().toLowerCase();
      const start = $('w-start').value, end = $('w-end').value;
      if (!currentShip) { err.textContent = T.needShip; err.style.display = 'block'; return; }
      if (!email) { err.textContent = T.needEmail; err.style.display = 'block'; return; }
      if (!start || !end || start > end) { err.textContent = T.invalidDates; err.style.display = 'block'; return; }
      try {
        const r = await fetch('/api/wms/watch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, ship: currentShip, sailingStart: start, sailingEnd: end }),
        });
        const d = await r.json();
        if (r.status === 403) {
          err.innerHTML = T.needSub; // includes the subscribe link
          err.style.display = 'block';
          return;
        }
        if (!d.ok) { err.textContent = d.error || T.saveFail; err.style.display = 'block'; return; }
        localStorage.setItem(emailKey, email);
        $('watch-form').style.display = 'none';
        const ok = $('watch-ok');
        ok.textContent = d.already ? T.savedAlready : T.savedNew;
        ok.style.display = 'block';
      } catch {
        err.textContent = T.saveFail;
        err.style.display = 'block';
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function init() {
    // One-click stop-watch redirects land back here with ?watch=stopped.
    const q = new URLSearchParams(location.search);
    if (q.get('watch') === 'stopped') {
      const el = document.createElement('div');
      el.className = 'ok-msg';
      el.style.cssText = 'display:block;max-width:640px;margin:0 0 24px';
      el.textContent = T.stopped;
      document.querySelector('.shell').prepend(el);
    }
    await loadShips();
    setupSearch();
    setupWatch();
    // Deep link: ?ship=Icon%20of%20the%20Seas
    const deepShip = q.get('ship');
    if (deepShip) { $('ship-input').value = deepShip; selectShip(deepShip); }
  }

  init();
})();
