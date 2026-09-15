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
  let lastFixMarker = null, routeLayer = null, nearbyLayer = null, plannedLayer = null;
  let pollTimer = null;
  let pollEvery = 60_000;   // current poll interval
  let selectedAt = 0;       // when the viewer picked the ship (fast polling window)
  function pollAt(shipName, every) {
    if (pollEvery === every && pollTimer) return;
    clearInterval(pollTimer);
    pollEvery = every;
    pollTimer = setInterval(() => refresh(shipName).catch(() => {}), every);
  }
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

  function shipIcon(courseDeg, estimated) {
    // A small bright-green cruise ship (side profile) with a soft glow. Bow
    // faces the direction of travel: eastbound faces right, westbound flips.
    // An ESTIMATED position (between AIS fixes) glows amber instead of green.
    const westbound = Number.isFinite(courseDeg) && courseDeg > 180 && courseDeg < 360;
    const glow = estimated ? 'rgba(255,217,93,.95)' : 'rgba(93,255,154,.95)';
    return L.divIcon({
      className: '',
      iconSize: [52, 36],
      iconAnchor: [26, 22],
      html: `<div style="width:52px;height:36px;${westbound ? 'transform:scaleX(-1);' : ''}${estimated ? 'opacity:.88;' : ''}filter:drop-shadow(0 0 6px ${glow})">
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

  // Other tracked ships inside the nearby radius: a small white hull with the
  // name beside it. Click one to track it instead.
  function nearbyIcon(name) {
    return L.divIcon({
      className: '',
      iconSize: [22, 14],
      iconAnchor: [11, 9],
      html: `<div style="display:flex;align-items:center;gap:5px;white-space:nowrap;filter:drop-shadow(0 1px 3px rgba(0,0,0,.9))">
        <svg viewBox="0 0 22 14" width="22" height="14"><g fill="#ffffff" stroke="#07183f" stroke-width="1">
          <path d="M1 9 L21 9 L18 13 L4 13 Z"/><path d="M5 5 L16 5 L16 9 L5 9 Z"/><path d="M8 2 L13 2 L13 5 L8 5 Z"/></g></svg>
        <span style="color:#fff;font:700 12px/1 'Baloo 2',system-ui,sans-serif;text-shadow:0 1px 3px #000">${name}</span></div>`,
    });
  }

  // The operator's planned itinerary: a thin green line through the scheduled
  // ports with small port dots, drawn beneath everything else, fix or no fix.
  function drawPlanned(p) {
    if (plannedLayer) { plannedLayer.remove(); plannedLayer = null; }
    var note = $('planned-note');
    if (!p || !p.segments || !p.segments.length) { if (note) note.textContent = ''; return null; }
    plannedLayer = L.layerGroup();
    p.segments.forEach(function (seg) { L.polyline(seg, { color: '#5dff9a', weight: 1.5, opacity: .55 }).addTo(plannedLayer); });
    (p.ports || []).forEach(function (pt) {
      if (pt.lat === null || pt.lon === null) return;
      L.circleMarker([pt.lat, pt.lon], { radius: 3, color: '#5dff9a', weight: 1, fillColor: '#07183f', fillOpacity: 1 })
        .bindTooltip(pt.name, { direction: 'top', offset: [0, -4] }).addTo(plannedLayer);
    });
    plannedLayer.addTo(map);
    if (note) note.textContent = T.planned(p);
    return L.featureGroup(plannedLayer.getLayers()).getBounds();
  }

  function drawRoute(route) {
    if (routeLayer) { routeLayer.remove(); routeLayer = null; }
    if (!route) return;
    routeLayer = L.layerGroup();
    // Thin green line: solid where she has been, dashed for the leg still ahead.
    if (route.travelled && route.travelled.length > 1) {
      L.polyline(route.travelled, { color: '#5dff9a', weight: 2, opacity: .9 }).addTo(routeLayer);
    }
    if (route.ahead && route.ahead.length > 1) {
      L.polyline(route.ahead, { color: '#5dff9a', weight: 2, opacity: .75, dashArray: '6 7' }).addTo(routeLayer);
    }
    routeLayer.addTo(map);
  }

  function drawNearby(list) {
    if (nearbyLayer) { nearbyLayer.remove(); nearbyLayer = null; }
    if (!list || !list.length) return;
    nearbyLayer = L.layerGroup();
    list.forEach((n) => {
      const m = L.marker([n.lat, n.lon], { icon: nearbyIcon(n.name), zIndexOffset: -100 });
      m.bindTooltip(`${n.name} · ${n.cruiseLine} · ${n.distanceNm} ${T.nm}${Number.isFinite(n.speedKn) ? ` · ${n.speedKn.toFixed(1)} ${T.kn}` : ''}`, { direction: 'top', offset: [0, -8] });
      m.on('click', () => { $('ship-input').value = n.name; selectShip(n.name); });
      m.addTo(nearbyLayer);
    });
    nearbyLayer.addTo(map);
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
    if (d.estimate) {
      banner.innerHTML = T.estimated(d.ship, T.ago(d.lastReportedMinAgo), T.basis[d.estimate.basis] || '');
      banner.style.display = 'block';
    } else if (d.stale) {
      banner.innerHTML = T.stale(d.ship, T.ago(d.lastReportedMinAgo));
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }

    const pill = $('live-pill');
    pill.style.display = 'block';
    pill.classList.toggle('stale', Boolean(d.stale || d.estimate));
    $('live-pill-text').textContent = d.estimate ? T.estimatedPill : d.stale ? T.stalePill : (d.source === 'satellite' ? T.satPill : T.livePill);
    const near = $('nearby-note');
    if (near) near.textContent = T.nearby((d.nearby || []).length, d.nearbyRadiusNm || 10);
  }

  // ── Weather card: the destination port on the day the ship is expected ─────
  async function renderWeather(dest, etaUtc) {
    const card = $('wx-card');
    if (!dest || !dest.slug) { card.style.display = 'none'; lastWeatherSlug = null; return; }
    const etaDate = etaUtc ? String(etaUtc).slice(0, 10) : '';
    const cacheKey = `${dest.slug}|${etaDate}`;
    if (cacheKey === lastWeatherSlug) return; // already rendered
    try {
      const r = await fetch(`/api/weather?place=${dest.slug}${LANG === 'es' ? '&lang=es' : ''}`);
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
      // Still draw the plan: the route exists before the first fix does.
      var pb = drawPlanned(d.planned);
      if (pb && pb.isValid()) map.fitBounds(pb, { padding: [30, 30] });
      // No fix yet. The subscription and any satellite answer land within
      // seconds of the request, so poll every 5 s for the first two minutes
      // after selection, then every 20 s. Polling never spends a credit.
      pollAt(shipName, Date.now() - selectedAt < 120_000 ? 5_000 : 20_000);
      return;
    }
    pollAt(shipName, 60_000);

    renderInfo(d);
    ensureMap();
    const fixPos = [d.position.lat, d.position.lon];
    const est = d.estimate;
    const pos = est ? [est.lat, est.lon] : fixPos;
    if (!marker) {
      marker = L.marker(pos, { icon: shipIcon(d.courseDeg, Boolean(est)) }).addTo(map);
      map.setView(pos, 8);
    } else {
      marker.setLatLng(pos);
      marker.setIcon(shipIcon(d.courseDeg, Boolean(est)));
      if (!map.getBounds().contains(pos)) map.setView(pos, map.getZoom());
    }
    marker.bindTooltip(est ? `${d.ship} · ${T.estimatedPill}` : d.ship, { direction: 'top', offset: [0, -20] });
    // The last REAL fix stays on the map as a small amber ring while we estimate.
    if (lastFixMarker) { lastFixMarker.remove(); lastFixMarker = null; }
    if (est && (est.lat !== d.position.lat || est.lon !== d.position.lon)) {
      lastFixMarker = L.circleMarker(fixPos, { radius: 6, color: '#ffd95d', weight: 2, fillColor: '#ffd95d', fillOpacity: .25 })
        .bindTooltip(T.lastFix(T.ago(d.lastReportedMinAgo)), { direction: 'top', offset: [0, -6] })
        .addTo(map);
    }
    drawPlanned(d.planned);
    drawRoute(d.route);
    drawNearby(d.nearby);
    $('updated').textContent = new Date().toLocaleTimeString(LANG === 'es' ? 'es-419' : 'en-US');
    renderWeather(d.destination, d.etaUtc);
  }

  function startTracking(shipName) {
    currentShip = shipName;
    clearInterval(pollTimer); pollTimer = null;
    refresh(shipName).catch(() => {});
    pollAt(shipName, 60_000);
    $('tracker').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function selectShip(shipName) {
    // Wake the ship's tracking (stamps the request; retained in the scheduler).
    // AWAITED: the request is also the one moment the server may ask a satellite
    // for a quiet ship (a second or two), so the first poll shows the answer.
    currentShip = shipName;
    selectedAt = Date.now();
    $('tracker').style.display = 'block';
    $('i-ship').textContent = shipName;
    $('stale-banner').innerHTML = T.checking(shipName);
    $('stale-banner').style.display = 'block';
    try {
      await fetch('/api/wms/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ship: shipName }),
      });
    } catch { /* the poll below reports whatever the tracker holds */ }
    if (currentShip !== shipName) return; // the viewer moved on
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
