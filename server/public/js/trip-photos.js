// trip-photos.js — fills a page's photo strip (css/trip-photos.css) from the photos its API answer carries (Mark 2026-10-26).
// SATripPhotos.render(host, photos) → true when at least one photo is shown; the page then hides its plain banner.
(function () {
  'use strict';
  var SLOTS = ['left', 'mid', 'right'];
  var PALMS = [['1%', '14%', -14], ['6%', '72%', 10], ['17%', '2%', 8], ['47%', '0%', -6], ['79%', '4%', 12], ['92%', '18%', -10], ['95%', '70%', 14], ['33%', '86%', -8], ['63%', '88%', 6]];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  window.SATripPhotos = {
    render: function (host, photos) {
      if (!host) return false;
      var list = Array.isArray(photos) ? photos.filter(function (p) { return p && p.url; }).slice(0, 3) : [];
      if (!list.length) { host.hidden = true; host.innerHTML = ''; return false; }
      var palms = PALMS.map(function (p) { return '<span class="palm" style="left:' + p[0] + ';top:' + p[1] + ';transform:rotate(' + p[2] + 'deg)">🌴</span>'; }).join('');
      var figs = list.map(function (p, i) { return '<figure class="ph ph-' + SLOTS[i] + '"><img src="' + esc(p.url) + '" alt="' + esc(p.alt) + '"></figure>'; }).join('');
      host.innerHTML = palms + '<div class="trip-photo-row">' + figs + '</div>';
      host.hidden = false;
      return true;
    },
  };
})();
