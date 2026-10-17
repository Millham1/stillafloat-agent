// my-cruise.js — the traveler's private cruise page (server/public/my-cruise.html).
// The link in the address is the only credential: it is read once, sent only to our own API (/api/my-cruise/<link>),
// and never logged, stored or echoed. Every word on the page, in English or Spanish, comes from the server
// (lib/group-journey-strings.ts), so there is one place for the two languages to stay in step.
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var token = (params.get('t') || (location.hash.match(/[#&]t=([^&]+)/) || [])[1] || '').trim();
  var forced = params.get('lang') === 'es' ? 'es' : params.get('lang') === 'en' ? 'en' : '';
  var $ = function (id) { return document.getElementById(id); };
  var view = null, busy = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function safe(u) { return /^https?:\/\//i.test(u) || /^#/.test(u) ? u : '#'; }
  function show(id, on) { $(id).hidden = !on; }
  function setState(msg) { $('mc-state').textContent = msg || ''; show('mc-state', !!msg); }
  function api(path, opts) {
    var q = forced ? (path.indexOf('?') < 0 ? '?' : '&') + 'lang=' + forced : '';
    return fetch('/api/my-cruise/' + encodeURIComponent(token) + (path || '') + q, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; });
    });
  }

  // ── sections ───────────────────────────────────────────────────────────────

  function table(t) {
    return '<div class="tbl"><table><thead><tr>' + t.head.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      t.rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }

  function checklist(list) {
    return '<ul class="ck">' + list.map(function (e) {
      return '<li class="' + (e.done ? 'done' : '') + '" data-row="' + esc(e.id) + '">' +
        '<input type="checkbox" id="ck-' + esc(e.id) + '" data-tick="' + esc(e.id) + '"' + (e.done ? ' checked' : '') + ' aria-label="' + esc(view.ui.tick + ': ' + e.title) + '">' +
        '<label for="ck-' + esc(e.id) + '"><span class="t">' + esc(e.title) + (e.dueText ? ' <span class="d">' + esc(e.dueText) + '</span>' : '') + '</span>' +
        (e.detail ? '<span class="d">' + esc(e.detail) + '</span>' : '') +
        (e.url ? '<span class="d"><a href="' + esc(safe(e.url)) + '" rel="noopener noreferrer" target="_blank">' + esc(e.url.replace(/^https?:\/\//, '').slice(0, 60)) + '</a></span>' : '') +
        '</label></li>';
    }).join('') + '</ul>';
  }

  function field(f, v) {
    var id = 'f-' + f.name, h = '<div class="fld"><label for="' + id + '">' + esc(f.label) + '</label>';
    if (f.kind === 'choice') {
      h += '<select id="' + id + '" name="' + f.name + '"><option value=""></option>' + f.options.map(function (o) {
        return '<option value="' + esc(o) + '"' + (v === o ? ' selected' : '') + '>' + esc((f.optionLabels && f.optionLabels[o]) || o) + '</option>';
      }).join('') + '</select>';
    } else {
      var type = f.kind === 'date' ? 'date' : f.kind === 'time' ? 'time' : f.kind === 'tel' ? 'tel' : 'text';
      h += '<input id="' + id + '" name="' + f.name + '" type="' + type + '" maxlength="' + f.max + '" value="' + esc(v || '') + '"' + (f.kind === 'tel' ? ' autocomplete="tel"' : ' autocomplete="off"') + '>';
    }
    return h + '</div>';
  }

  function form(sx) {
    var d = view.details;
    return '<form id="mc-form" novalidate>' + d.fields.map(function (f) { return field(f, d.values[f.name]); }).join('') +
      '<div class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<div id="mc-form-msg" role="status" aria-live="polite"></div>' +
      '<button type="submit" class="btn" id="mc-save">' + esc(view.ui.save) + '</button></form>';
  }

  function section(sx) {
    var h = '<section class="card' + (sx.tone === 'notice' ? ' notice' : '') + '" id="' + (sx.key === 'details' ? 'details' : 's-' + esc(sx.key)) + '">';
    if (sx.title) h += '<h2>' + esc(sx.title) + '</h2>';
    (sx.lines || []).forEach(function (l) { h += '<p>' + esc(l) + '</p>'; });
    if (sx.items && sx.items.length) {
      h += '<ul>' + sx.items.map(function (i) { return '<li>' + (i.url ? '<a href="' + esc(safe(i.url)) + '" rel="noopener noreferrer" target="_blank">' + esc(i.text) + '</a>' : esc(i.text)) + '</li>'; }).join('') + '</ul>';
    }
    if (sx.table) h += table(sx.table);
    if (sx.checklist) h += checklist(sx.checklist);
    if (sx.form === 'details') h += form(sx);
    if (sx.links && sx.links.length) {
      h += '<div class="links">' + sx.links.map(function (l) {
        var primary = sx.key === 'paperwork' && l.url === view.paperworkUrl;
        return '<a ' + (primary ? 'class="btn" ' : '') + 'href="' + esc(safe(l.url)) + '"' + (/^#/.test(l.url) ? '' : ' rel="noopener noreferrer"') + '>' + esc(l.label) + '</a>';
      }).join('') + '</div>';
    }
    return h + '</section>';
  }

  function render() {
    document.documentElement.lang = view.lang;
    document.title = view.title + ' | Still Afloat Cruising';
    $('mc-plaque').textContent = view.title;
    $('mc-h1').textContent = view.hello;
    var c = $('mc-count');
    if (view.countdown && view.countdown.text) { c.textContent = view.countdown.text; c.hidden = false; } else c.hidden = true;
    var sw = $('mc-lang'); sw.textContent = view.ui.langSwitch; sw.hidden = false;
    $('mc-body').innerHTML = view.sections.map(section).join('');
    var contact = $('mc-contact');
    contact.textContent = view.business.contact; contact.hidden = false;
    $('mc-foot').textContent = view.ui.footer;
    setState(''); show('mc-body', true);
  }

  // ── actions ────────────────────────────────────────────────────────────────

  function load(keepScroll) {
    var y = window.scrollY;
    return api('').then(function (r) {
      if (r.status !== 200 || !r.json || !r.json.success) { setState((r.json && r.json.error) || 'We could not open this link. Please try again later.'); show('mc-body', false); return; }
      view = r.json; render();
      if (keepScroll) window.scrollTo(0, y);
    }).catch(function () { setState('We could not reach the server. Please check your connection and try again. / No pudimos conectar con el servidor.'); });
  }

  function tick(box) {
    var li = box.closest('li'), id = box.getAttribute('data-tick'), want = box.checked;
    li.classList.toggle('done', want);
    api('/checklist/' + encodeURIComponent(id) + '/done', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: want }) })
      .then(function (r) { if (!(r.status === 200 && r.json && r.json.success)) throw new Error('x'); })
      .catch(function () { box.checked = !want; li.classList.toggle('done', !want); });
  }

  function clearErrors() {
    var errs = document.querySelectorAll('#mc-form .field-err'); for (var i = 0; i < errs.length; i++) errs[i].remove();
    var bad = document.querySelectorAll('#mc-form [aria-invalid]'); for (var j = 0; j < bad.length; j++) bad[j].removeAttribute('aria-invalid');
    $('mc-form-msg').innerHTML = '';
  }

  function save(e) {
    e.preventDefault();
    if (busy) return;
    clearErrors();
    var f = $('mc-form'), body = {};
    for (var i = 0; i < f.elements.length; i++) { var el = f.elements[i]; if (el.name) body[el.name] = el.value; }
    busy = true; $('mc-save').disabled = true;
    api('/details', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      busy = false; $('mc-save').disabled = false;
      var j = r.json || {};
      if (r.status === 200 && j.success) {
        // show the confirmation, then redraw with what is now on file (the list of what we still need shrinks)
        load(true).then(function () { var m = $('mc-form-msg'); if (m) { m.innerHTML = '<p class="ok-box">' + esc(j.message || view.ui.saved) + '</p>'; } });
        return;
      }
      if (r.status === 404 || r.status === 429) { setState((j && j.error) || ''); return; }
      $('mc-form-msg').innerHTML = '<p class="err-box" role="alert">' + esc(j.error || view.ui.saveFailed) + '</p>';
      Object.keys(j.fields || {}).forEach(function (name) {
        var el = f.elements[name]; if (!el) return;
        el.setAttribute('aria-invalid', 'true');
        var s = document.createElement('span'); s.className = 'field-err'; s.textContent = j.fields[name];
        el.parentNode.appendChild(s);
      });
    }).catch(function () { busy = false; $('mc-save').disabled = false; $('mc-form-msg').innerHTML = '<p class="err-box" role="alert">' + esc(view.ui.saveFailed) + '</p>'; });
  }

  document.addEventListener('change', function (e) { var t = e.target; if (t && t.getAttribute && t.getAttribute('data-tick')) tick(t); });
  document.addEventListener('submit', function (e) { if (e.target && e.target.id === 'mc-form') save(e); });
  $('mc-lang').addEventListener('click', function () { forced = view.otherLang; load(false); });

  if (!token) { setState('This page opens from your private link. Please use the link in your email. / Esta página se abre desde su enlace privado. Use el enlace de su correo.'); return; }
  load(false);
})();
