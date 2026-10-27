// forms.js — the traveler's private paperwork page (server/public/forms.html): short screens with a Continue button (Mark 2026-10-26).
// The link in the address is the only credential: it is read once, sent only to our own API
// (/api/forms/<link>), and never logged, stored or echoed. All rules (what is shown, what is
// accepted, what a signature pins) live on the server in lib/group-forms.ts.
// The page declares where it talks to (main[data-api]); the check in e2e/checks/ops.mjs reads the same attribute.
var API_BASE = (function () { var m = document.querySelector('main[data-api]'); return (m && m.getAttribute('data-api')) || '/api/forms/'; })();

(function () {
  'use strict';
  // The link is the credential: it is read once from the address, sent only to our own API, and never logged or echoed.
  var params = new URLSearchParams(location.search);
  var token = (params.get('t') || (location.hash.match(/[#&]t=([^&]+)/) || [])[1] || '').trim();
  var $ = function (id) { return document.getElementById(id); };
  var packet = null, busy = false;
  var newsWanted = false;   // Mark 2026-10-26: the newsletter is asked once, at the start; the answer rides with the next signature

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function show(id, on) { $(id).hidden = !on; }
  function setState(msg) { $('fm-state').textContent = msg || ''; show('fm-state', !!msg); }
  function api(path, opts) {
    return fetch(API_BASE + encodeURIComponent(token) + (path || ''), opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; });
    });
  }

  // ── The home address, checked with the post office as it is typed (Mark 2026-10-26, the same service and words as the details page) ──
  // A street box (a field ending "address") is paired with its "city_state_zip" box. Once the street has five characters and the second box
  // holds a ZIP (or a city and state), the post office's whole address is offered under the boxes; "Yes" fills both, "No" leaves them as typed.
  var ADDR = {
    tidied: "We tidied it to the post office's spelling:", right: 'Right?', yes: 'Yes', no: "No, I'll fix it",
    nf: "We couldn't find that one… check the street and ZIP.", na: "We couldn't check that address right now, so we'll take it as typed.",
  };
  function tidy(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function splitCsz(s) {
    var t = tidy(s), m = /^(.*?)[\s,]+([A-Za-z]{2})\.?(?:[\s,]+(\d{5})(?:-?\d{4})?)?$/.exec(t);
    if (m) return { city: m[1].replace(/[,\s]+$/, ''), state: m[2].toUpperCase(), zip: m[3] || '' };
    var z = /(\d{5})(?:-?\d{4})?$/.exec(t);
    return { city: z ? tidy(t.slice(0, z.index).replace(/[,\s]+$/, '')) : t, state: '', zip: z ? z[1] : '' };
  }
  function addressCheck(body) {
    var streets = body.querySelectorAll('input[data-field$="address"]');
    for (var i = 0; i < streets.length; i++) {
      var street = streets[i], name = street.getAttribute('data-field');
      var csz = body.querySelector('input[data-field="' + name.replace(/address$/, 'city_state_zip') + '"]');
      if (csz && !street.disabled) pairUp(street, csz);
    }
  }
  function pairUp(street, csz) {
    var box = document.createElement('div'); box.className = 'addr-fix'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); box.hidden = true;
    csz.parentNode.insertBefore(box, csz.nextSibling);
    var look = { key: '', off: false, sugg: [], timer: null };
    // Mark 2026-10-26, the type-ahead: as the street is typed, whole addresses drop down under it; tapping one fills both boxes.
    // Without the type-ahead service (no keys, or it failed) the post office's whole-address check below does the work.
    var drop = document.createElement('div'); drop.className = 'addr-drop'; drop.setAttribute('role', 'listbox'); drop.hidden = true;
    street.parentNode.insertBefore(drop, street.nextSibling);
    var ahead = { off: false, timer: null, asked: '' };
    function closeDrop() { drop.hidden = true; drop.innerHTML = ''; }
    function take(s) {
      street.value = s.street; csz.value = s.city + ', ' + s.state + ' ' + s.zip; closeDrop(); say(''); ahead.asked = tidy(s.street); look.key = keyNow();
      street.dispatchEvent(new Event('input', { bubbles: true })); look.key = keyNow(); closeDrop();
    }
    function suggest() {
      var q = tidy(street.value);
      if (ahead.off || q.length < 4 || q === ahead.asked) return;
      ahead.asked = q;
      fetch('/api/address/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: q, website: ($('fm-website') || {}).value || '' }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j || {} }; }); })
        .then(function (x) {
          if (tidy(street.value) !== q) return;               // typed on since
          if (!x.ok || !x.j.available) { ahead.off = true; closeDrop(); return; }
          var list = (x.j.suggestions || []).slice(0, 5);
          if (!list.length) { closeDrop(); return; }
          drop.innerHTML = list.map(function (s, j) { return '<button type="button" role="option" data-s="' + j + '">' + esc(s.formatted) + '</button>'; }).join('');
          var bs = drop.querySelectorAll('button');
          for (var k = 0; k < bs.length; k++) bs[k].onclick = function () { take(list[Number(this.getAttribute('data-s'))]); };
          drop.hidden = false;
        })
        .catch(function () { ahead.off = true; closeDrop(); });
    }
    street.addEventListener('input', function () { clearTimeout(ahead.timer); if (tidy(street.value).length < 4) closeDrop(); else ahead.timer = setTimeout(suggest, 250); });
    street.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrop(); });
    function keyNow() { return (tidy(street.value) + '|' + tidy(csz.value)).toLowerCase(); }
    function say(html) { box.innerHTML = html; box.hidden = !html; }
    function offer(s) {
      say(esc(ADDR.tidied) + ' <b>' + esc(s.formatted) + '</b>. ' + esc(ADDR.right) + ' <button type="button" class="addr-yes">' + esc(ADDR.yes) + '</button> · <button type="button" class="linkbtn addr-no">' + esc(ADDR.no) + '</button>');
      box.querySelector('.addr-yes').onclick = function () {
        street.value = s.street; csz.value = s.city + ', ' + s.state + ' ' + s.zip;
        look.key = keyNow(); say('');
        street.dispatchEvent(new Event('input', { bubbles: true })); look.key = keyNow();
      };
      box.querySelector('.addr-no').onclick = function () { say(''); street.focus(); };
    }
    function same(s) {
      var c = splitCsz(csz.value), n = function (x) { return tidy(x).toLowerCase().replace(/[.,]/g, ''); };
      return n(s.street) === n(street.value) && n(s.city) === n(c.city) && s.state === c.state && tidy(s.zip).slice(0, 5) === c.zip;
    }
    function ask() {
      var key = keyNow(), c = splitCsz(csz.value);
      if (look.off || key === look.key || tidy(street.value).length < 5 || !(c.zip || (c.state && c.city))) return;   // a street and a ZIP are enough
      fetch('/api/address/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: tidy(street.value), city: c.city, state: c.state, zip: c.zip, website: ($('fm-website') || {}).value || '' }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j || {} }; }); })
        .then(function (x) {
          if (keyNow() !== key) return;                     // typed on since: a newer question is on its way
          if (!x.ok || !x.j.available) { look.off = true; say(esc(ADDR.na) + (x.j.why ? ' <span class="addr-why">(Test site: ' + esc(x.j.why) + ')</span>' : '')); return; }
          if (x.j.incomplete) return;
          look.key = key;
          var list = (x.j.suggestions || []).slice(0, 5);
          if (!list.length) { say(esc(ADDR.nf)); return; }
          if (list.length === 1) { if (same(list[0])) say(''); else offer(list[0]); return; }
          say(list.map(function (s, j) { return '<button type="button" class="addr-pick" data-s="' + j + '">' + esc(s.formatted) + '</button>'; }).join(''));
          var picks = box.querySelectorAll('.addr-pick');
          for (var k = 0; k < picks.length; k++) picks[k].onclick = function () { offer(list[Number(this.getAttribute('data-s'))]); };
        })
        .catch(function () { look.off = true; say(esc(ADDR.na)); });
    }
    function typed() { if (look.off || keyNow() === look.key) return; say(''); clearTimeout(look.timer); look.timer = setTimeout(ask, 500); }
    street.addEventListener('input', typed); csz.addEventListener('input', typed);
    if (tidy(street.value) && tidy(csz.value)) typed();
  }

  function firstName() { return (packet && packet.traveler && packet.traveler.first_name) || ''; }
  function docByKey(k) { for (var i = 0; i < packet.docs.length; i++) if (packet.docs[i].key === k) return packet.docs[i]; return null; }
  function pending() { return packet.docs.filter(function (d) { return d.status !== 'signed'; }); }

  function tripBox() {
    var g = packet.group || {}, c = packet.cabin;
    var when = [g.sail_date_text, g.return_date_text].filter(Boolean).join(' to ');
    var lines = ['<b>' + esc(g.name || 'Your cruise') + '</b>'];
    var ship = [g.cruise_line, g.ship_name].filter(Boolean).join(' · ');
    if (ship) lines.push(esc(ship));
    if (when) lines.push('Sailing ' + esc(when) + (g.embark_port ? ' from ' + esc(g.embark_port) : ''));
    if (c && (c.cabin_num || c.category)) lines.push('Cabin ' + esc([c.cabin_num, c.category].filter(Boolean).join(' · ')));
    if (packet.mates && packet.mates.length) lines.push('Sharing with ' + esc(packet.mates.join(', ')));
    return '<div class="trip">' + lines.join('<br>') + '</div>';
  }

  // Mark 2026-10-25: the one-time consent to electronic records comes before the first signature (ESIGN consumer consent).
  function consented() { return !packet.esign || !!packet.esign.consent_given_at; }

  // ── The steps (Mark 2026-10-26: "one page worth with a continue button … we should be able to get it down to 5 minutes") ──
  // Each screen fits on one page. The questions of every document still to sign are asked once, by step; a question two documents
  // share is asked once and goes to both. Any question not named here is asked on the last screen, under its own document.
  var STEPS = [
    { id: 'welcome', title: 'Welcome aboard' },
    { id: 'about', title: 'About you', fields: ['legal_name', 'dob', 'gender', 'us_citizen', 'citizenship'] },
    { id: 'home', title: 'Where you live', fields: ['address', 'city_state_zip', 'phone', 'email'] },
    { id: 'travel', title: 'Travel documents', fields: ['passport_number', 'passport_country', 'passport_issue', 'passport_expiry', 'passport_place', 'trusted_programs', 'ktn', 'global_entry_number',
      'loyalty_1_program', 'loyalty_1_number', 'loyalty_2_program', 'loyalty_2_number', 'loyalty_3_program', 'loyalty_3_number'] },
    { id: 'contact', title: 'Emergency contact', fields: ['ec1_name', 'ec1_relationship', 'ec1_cell_phone', 'ec1_email', 'ec1_address', 'ec1_city_state_zip', 'notes'] },
    { id: 'sign', title: 'Review and sign' },
  ];
  // A follow-up line shows right under the choice it belongs to, only when that choice is ticked.
  var FOLLOW = { us_citizen: { no: ['citizenship'] }, trusted_programs: { tsa: ['ktn'], global: ['global_entry_number'] } };
  var SUMMARY = {
    '15-emergency-contact-form': 'The answers you just gave: who you are, how to reach you, and who to call in an emergency.',
    '01-terms-and-conditions': 'How we work together: what we do, what the cruise line does, and how changes and cancellations are handled.',
    '05-liability-waiver': 'Travel has risks no one controls; you accept them, and the cruise line and suppliers answer for their own services.',
    '07-travel-insurance-declination': 'Your travel insurance choice.',
    '16-passport-document-checklist': 'Your travel documents checklist.',
    '12-cruise-booking-agreement': 'Your cabin, your price and the cruise line\'s rules for this booking.',
    '09-group-travel-contract': 'The group\'s contract: the cabins held, the dates and the cruise line\'s terms.',
  };
  var AUTO = { legal_name: 'name', dob: 'bday', email: 'email', phone: 'tel', address: 'address-line1', ec1_name: 'off', ec1_cell_phone: 'off' };

  var fields = {}, order = [], steps = [], at = 0;   // the questions of the documents still to sign, by name; the screens shown
  function gather() {
    fields = {}; order = [];
    pending().forEach(function (d) {
      d.fields.forEach(function (f) {
        if (!fields[f.name]) { fields[f.name] = { f: f, docs: [] }; order.push(f.name); }
        fields[f.name].docs.push(d.key);
        if (f.required) fields[f.name].f.required = true;
      });
    });
    var named = {};
    STEPS.forEach(function (s) { (s.fields || []).forEach(function (n) { named[n] = true; }); });
    steps = STEPS.filter(function (s) { return !s.fields || s.fields.some(function (n) { return fields[n]; }); });
    return named;
  }

  function control(f) {
    var id = 'w-' + f.name, v = f.value, req = f.required ? ' req' : '';
    var lab = '<span class="w-label">' + esc(f.label) + (f.required ? '' : ' <span class="w-opt">(optional)</span>') + '</span>';
    if (f.kind === 'choice' || f.kind === 'multi') {
      var type = f.kind === 'choice' ? 'radio' : 'checkbox', follow = FOLLOW[f.name] || {};
      return '<fieldset class="w-field' + req + '" data-q="' + esc(f.name) + '"><legend>' + lab + '</legend>' + (f.options || []).map(function (o) {
        var on = Array.isArray(v) ? v.indexOf(o.value) >= 0 : v === o.value;
        return '<label class="w-opt-row"><input type="' + type + '" name="' + esc(f.name) + '" data-field="' + esc(f.name) + '" value="' + esc(o.value) + '"' + (on ? ' checked' : '') + '><span>' + esc(o.label) + '</span></label>' +
          (follow[o.value] || []).map(function (n) { return fields[n] ? '<div class="w-follow" data-follow="' + esc(f.name) + ':' + esc(o.value) + '">' + control(fields[n].f) + '</div>' : ''; }).join('');
      }).join('') + '</fieldset>';
    }
    if (f.kind === 'check') {
      return '<div class="w-field' + req + '" data-q="' + esc(f.name) + '"><label class="w-opt-row"><input type="checkbox" id="' + id + '" data-field="' + esc(f.name) + '"' + (v === true ? ' checked' : '') + '><span>' + esc(f.label) + '</span></label></div>';
    }
    if (f.kind === 'textarea') {
      return '<div class="w-field" data-q="' + esc(f.name) + '"><label for="' + id + '">' + lab + '</label><textarea class="w-in" id="' + id + '" data-field="' + esc(f.name) + '" rows="3">' + esc(v || '') + '</textarea></div>';
    }
    var type2 = f.kind === 'date' ? 'date' : f.kind === 'email' ? 'email' : f.kind === 'tel' ? 'tel' : 'text';
    var extra = (f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') + ' autocomplete="' + (AUTO[f.name] || 'off') + '"';
    var note = '';
    if (f.kind === 'passport') {
      if (!packet.pii_ready) { extra += ' disabled'; note = 'We cannot take a passport number on this page right now. Leave it empty; we will ask for it another way.'; }
      else if (packet.traveler && packet.traveler.passport_on_file) note = 'A passport ' + packet.traveler.passport_on_file + ' is already on file. Type the number again only if it has changed.';
      else note = 'Optional on this sailing. Stored encrypted and never shown again, not even to you.';
    }
    return '<div class="w-field' + req + '" data-q="' + esc(f.name) + '"><label for="' + id + '">' + lab + '</label><input class="w-in" type="' + type2 + '" id="' + id + '" data-field="' + esc(f.name) + '" value="' + esc(typeof v === 'string' ? v : '') + '"' + extra + '>' +
      (note ? '<p class="passport-note">' + esc(note) + '</p>' : '') + '</div>';
  }

  function isFollow(n) { for (var k in FOLLOW) for (var o in FOLLOW[k]) if (FOLLOW[k][o].indexOf(n) >= 0 && fields[k]) return true; return false; }
  function stepBody(s, named) {
    if (s.id === 'welcome') {
      var c = packet.esign && packet.esign.text, h = '<p class="lead">Hello' + (firstName() ? ' ' + esc(firstName()) : '') + '! ' +
        (packet.kind === 'organizer' ? 'Here is the group contract to read and sign.' : 'Five quick screens and your paperwork is done: about 5 minutes, less time than the line at the buffet!') + '</p>' + tripBox();
      if (!consented() && c) h += '<div class="w-box"><b>' + esc(c.title) + '</b><p>' + esc(c.intro) + '</p><ul>' + c.points.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '<label class="w-opt-row"><input type="checkbox" id="fm-esign" data-nokeep><span>' + esc(c.tick) + '</span></label></div>';
      if (packet.kind === 'traveler' && !(packet.traveler && packet.traveler.newsletter_opt_in))
        h += '<label class="w-opt-row"><input type="checkbox" id="fm-news"' + (newsWanted ? ' checked' : '') + '><span>Send me the Still Afloat Cruising newsletter. (Optional. You can unsubscribe at any time.)</span></label>';
      return h;
    }
    if (s.id === 'sign') {
      var h2 = '<p class="lead">Last screen. Tick each document to say you have read it and agree, then type your name once to sign them all.</p><ul class="w-docs">';
      pending().forEach(function (d) {
        // only what is still required is asked here; the optional questions of a document (its advisory level, insurance details, dining and
        // occasions) are the ones Mark fills in from the file (Mark 2026-10-26), so they are not put to the client
        var rest = d.fields.filter(function (f) { return f.required && !named[f.name] && !isFollow(f.name) && fields[f.name] && fields[f.name].docs[0] === d.key; });
        h2 += '<li><label class="w-opt-row"><input type="checkbox" class="w-agree" data-doc="' + esc(d.key) + '" data-nokeep><span><b>' + esc(d.title) + '</b><br>' + esc(SUMMARY[d.key] || '') + '</span></label>' +
          '<button type="button" class="linkbtn w-read" data-read="' + esc(d.key) + '">Read it</button>' +
          (rest.length ? '<div class="w-sub">' + rest.map(function (f) { return control(f); }).join('') + '</div>' : '') + '</li>';
      });
      h2 += '</ul><label class="nm" for="fm-name">Type your full name to sign</label><input type="text" id="fm-name" autocomplete="name" maxlength="120" placeholder="First and last name">' +
        '<p class="hint fine">Typing your name is your legal signature on each document you ticked. The date and time and the exact text you agreed to are saved with each one, and you get a signed copy of each by email.</p>';
      return h2;
    }
    var list = s.fields.filter(function (n) { return fields[n] && !isFollow(n); });
    var html = '', loyalty = list.filter(function (n) { return /^loyalty_/.test(n); });
    list.filter(function (n) { return !/^loyalty_/.test(n); }).forEach(function (n) { html += control(fields[n].f); });
    if (loyalty.length) {
      var any = loyalty.some(function (n) { return fields[n].f.value; });
      html += '<fieldset class="w-field"><legend><span class="w-label">Do you belong to any Loyalty Programs?</span> <span class="w-opt">(optional)</span></legend>' +
        '<label class="w-opt-row"><input type="radio" name="w-loyal" id="w-loyal-no" value="no"' + (any ? '' : ' checked') + '><span>No</span></label>' +
        '<label class="w-opt-row"><input type="radio" name="w-loyal" id="w-loyal-yes" value="yes"' + (any ? ' checked' : '') + '><span>Yes</span></label>' +
        '<div class="w-follow w-loyal-rows" data-follow="w-loyal:yes"><div class="w-pairs">' + loyalty.map(function (n) { return control(fields[n].f); }).join('') + '</div></div></fieldset>';
    }
    return html;
  }

  function renderWizard() {
    var named = gather();
    var host = $('fm-steps');
    host.innerHTML = steps.map(function (s, i) {
      return '<section class="w-step" data-step="' + i + '" hidden><h2>' + esc(s.title) + '</h2>' + stepBody(s, named) + '</section>';
    }).join('');
    addressCheck(host);
    followUps();
    if (window.SAKeep) { window.SAKeep.track(host, wizKey); window.SAKeep.restore(host, wizKey()); followUps(); }
    show('fm-wiz', true); show('fm-done', false); show('fm-doc', false);
    goStep(Math.min(at, steps.length - 1), true);
  }
  function wizKey() { return window.SAKeep ? window.SAKeep.keyFor('forms', token) + ':steps' : null; }

  // a follow-up line shows only under the choice it belongs to
  function followUps() {
    var els = $('fm-steps').querySelectorAll('[data-follow]');
    for (var i = 0; i < els.length; i++) {
      var p = els[i].getAttribute('data-follow').split(':'), name = p[0], val = p[1];
      var box = name === 'w-loyal' ? $('w-loyal-yes') : $('fm-steps').querySelector('[data-field="' + name + '"][value="' + val + '"]');
      els[i].hidden = !(box && box.checked);
    }
  }

  function goStep(i, quiet) {
    at = i;
    var all = $('fm-steps').querySelectorAll('.w-step');
    for (var k = 0; k < all.length; k++) all[k].hidden = Number(all[k].getAttribute('data-step')) !== i;
    $('fm-progress').textContent = 'Step ' + (i + 1) + ' of ' + steps.length;
    $('fm-prev').hidden = i === 0;
    $('fm-next').textContent = steps[i].id === 'sign' ? 'Sign' : steps[i].id === 'welcome' ? "Let's go!" : 'Continue';
    hideErr();
    if (!quiet) window.scrollTo(0, Math.max(0, $('fm-wiz').getBoundingClientRect().top + window.pageYOffset - 20));
  }

  function stepEl(i) { return $('fm-steps').querySelector('.w-step[data-step="' + i + '"]'); }
  function stepOf(name) {
    var el = $('fm-steps').querySelector('[data-field="' + name + '"]'), s = el && el.closest('.w-step');
    return s ? Number(s.getAttribute('data-step')) : -1;
  }
  function value(name) {
    var els = $('fm-steps').querySelectorAll('[data-field="' + name + '"]'), f = fields[name] && fields[name].f;
    if (!els.length || !f) return undefined;
    if (f.kind === 'choice') { for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value; return undefined; }
    if (f.kind === 'multi') { var out = []; for (var k = 0; k < els.length; k++) if (els[k].checked) out.push(els[k].value); return out; }
    if (f.kind === 'check') return !!els[0].checked;
    if (els[0].disabled) return undefined;
    var v = els[0].value.trim(); return v ? v : undefined;
  }
  /** What a step still needs: its required questions that are empty and in view (a hidden follow-up is not asked). */
  function stepGaps(i) {
    var out = {}, names = [], el = stepEl(i);
    var qs = el.querySelectorAll('[data-q]');
    for (var k = 0; k < qs.length; k++) {
      var n = qs[k].getAttribute('data-q'), f = fields[n] && fields[n].f;
      if (!f || !f.required || qs[k].closest('[hidden]') !== null && qs[k].closest('[hidden]') !== el) continue;
      var v = value(n);
      if (v === undefined || v === false || (Array.isArray(v) && !v.length)) { out[n] = f.kind === 'check' ? 'Please tick this box.' : (f.kind === 'choice' || f.kind === 'multi') ? 'Please choose one.' : 'Please fill this in.'; names.push(f.label); }
    }
    return { fields: out, names: names };
  }

  function next() {
    if (busy) return;
    hideErr();
    var s = steps[at];
    if (s.id === 'welcome' && !consented()) {
      if (!$('fm-esign').checked) { showErr('Please tick the box to agree to signing electronically.'); return; }
      busy = true; $('fm-next').disabled = true;
      return api('/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agreed: true, website: ($('fm-website') || {}).value || '' }) })
        .then(function (r) {
          busy = false; $('fm-next').disabled = false;
          var j = r.json || {};
          if (r.status === 200 && j.success && j.packet) { packet.esign = j.packet.esign; goStep(at + 1); return; }
          showErr(j.error || 'That did not go through. Please try again.');
        }).catch(function () { busy = false; $('fm-next').disabled = false; showErr('We could not reach the server. Please check your connection and try again.'); });
    }
    var gaps = stepGaps(at);
    if (gaps.names.length) { showErr('Before you continue, please fill in ' + (gaps.names.length === 1 ? 'this line' : 'these ' + gaps.names.length + ' lines') + ': ' + gaps.names.join(', ') + '.'); fieldErrors(gaps.fields); return; }
    if (s.id === 'sign') return signAll();
    goStep(at + 1);
  }

  // ── Signing: each ticked document is signed and recorded on its own, one after the other, with the answers that belong to it ──
  function answersFor(doc) {
    var out = {};
    doc.fields.forEach(function (f) {
      var v = value(f.name);
      if (f.kind === 'multi') { if (v && v.length) out[f.name] = v; }
      else if (f.kind === 'check') out[f.name] = !!v;
      else if (v !== undefined) out[f.name] = v;
    });
    return out;
  }
  function signAll() {
    var docs = pending(), name = $('fm-name').value.replace(/\s+/g, ' ').trim();
    var unticked = docs.filter(function (d) { var b = $('fm-steps').querySelector('.w-agree[data-doc="' + d.key + '"]'); return !(b && b.checked); });
    if (unticked.length) { showErr('Please tick ' + (unticked.length === 1 ? 'this document' : 'each document') + ' to say you have read it and agree: ' + unticked.map(function (d) { return d.title; }).join(', ') + '.'); return; }
    if (name.split(' ').length < 2) { showErr('Please type your full name (first and last) as your signature.'); $('fm-name').focus(); return; }
    busy = true; $('fm-next').disabled = true; $('fm-next').textContent = 'Signing…';
    var i = 0;
    function one() {
      if (i >= docs.length) { busy = false; if (window.SAKeep) window.SAKeep.clear(wizKey()); return showDone(); }
      var d = docs[i];
      return api('/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        doc_key: d.key, signer_name: name, agreed: true, content_sha256: d.text_sha256, answers: answersFor(d), newsletter_opt_in: newsWanted, website: ($('fm-website') || {}).value || '',
      }) }).then(function (r) {
        var j = r.json || {};
        if ((r.status === 200 && j.success) || (r.status === 409 && j.code === 'already-signed')) { if (j.packet) packet = j.packet; i++; return one(); }
        busy = false; $('fm-next').disabled = false; $('fm-next').textContent = 'Sign';
        if (r.status === 409 && j.code === 'document-changed') return reload('A document was just updated, so please look over the last screen again before you sign.');
        if (r.status === 400 && j.code === 'consent-required') { packet.esign = { text: packet.esign && packet.esign.text }; return reload(); }
        if (r.status === 404) { setState(j.error || 'This link is not valid.'); show('fm-wiz', false); return; }
        // a refused answer: go to the screen that asks it
        var bad = Object.keys(j.fields || {}), s = bad.length ? stepOf(bad[0]) : -1;
        if (s >= 0) goStep(s);
        showErr((j.error || 'That did not go through. Please try again.') + (i ? ' (' + i + ' of ' + docs.length + ' documents are already signed.)' : ''));
        fieldErrors(j.fields);
      }).catch(function () { busy = false; $('fm-next').disabled = false; $('fm-next').textContent = 'Sign'; showErr('We could not reach the server. Please check your connection and try again.'); });
    }
    return one();
  }

  function reload(msg) {
    return api('').then(function (r) {
      if (r.status !== 200 || !r.json || !r.json.success) { setState((r.json && r.json.error) || 'This link is not valid.'); show('fm-wiz', false); return; }
      packet = r.json; render();
      if (msg) showErr(msg);
    });
  }

  // ── "Read it": the whole document, laid out like the paper original, with the answers given so far ──
  function readDoc(key) {
    var doc = docByKey(key); if (!doc) return;
    $('fm-doc-title').textContent = doc.title;
    var body = $('fm-doc-body'); body.innerHTML = doc.html;
    doc.fields.forEach(function (f) {
      var v = value(f.name), els = body.querySelectorAll('[data-field="' + f.name + '"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.type === 'radio') el.checked = el.value === v;
        else if (el.type === 'checkbox') el.checked = Array.isArray(v) ? v.indexOf(el.value) >= 0 : v === true;
        else el.value = v == null ? '' : String(v);
        el.disabled = true;
      }
    });
    show('fm-wiz', false); show('fm-doc', true);
    window.scrollTo(0, 0); $('fm-doc-title').focus();
  }

  function showDone() {
    show('fm-wiz', false); show('fm-doc', false);
    var who = firstName();
    $('fm-done').innerHTML = '<h2>All done' + (who ? ', ' + esc(who) : '') + '!</h2>' +
      '<p class="lead">' + (packet.kind === 'organizer' ? 'Your group contract is signed.' : 'Your paperwork is complete. That is the boring part finished; the next thing on your list is packing!') + '</p>' +
      '<p>A signed copy of each document is kept on file with ' + esc(packet.business ? packet.business.name : 'us') + '. ' +
      (packet.copies_sent_at ? 'We have also emailed you your own copy of each signed document. ' : '') +
      (packet.kind === 'organizer' ? 'Mark will add the agent signature and be in touch. ' : 'There is nothing more to do right now. We will contact you if anything is missing or changes. ') +
      'You can close this page; opening your link again shows what is signed.</p>' + tripBox() +
      '<p class="fine">Questions? ' + esc(packet.business ? packet.business.contact : '') + '</p>';
    show('fm-done', true);
    window.scrollTo(0, 0);
  }

  // Mark 2026-10-26: the page opens on the trip's own photos (left, middle, right, tilted), never the website's banner.
  function photos() {
    if (window.SATripPhotos) window.SATripPhotos.render($('fm-photos'), packet.group && packet.group.photos);
  }

  function render() {
    setState('');
    photos();
    $('fm-foot').textContent = (packet.business && packet.business.name) || 'Still Afloat Cruising';
    if (packet.docs.length && !pending().length) showDone(); else renderWizard();
  }

  function showErr(msg) { var e = $('fm-err'); e.textContent = msg; e.hidden = false; }
  function hideErr() {
    $('fm-err').hidden = true;
    var errs = document.querySelectorAll('#fm-steps .field-err'); for (var i = 0; i < errs.length; i++) errs[i].remove();
    var bad = document.querySelectorAll('#fm-steps [aria-invalid]'); for (var j = 0; j < bad.length; j++) bad[j].removeAttribute('aria-invalid');
  }
  // Mark 2026-10-26: "the page alerted me but didn't take me to the errors". The page goes to the first problem, and the message lists
  // every problem as a link that goes straight to it.
  function fieldEl(name) { return $('fm-steps').querySelector('[data-field="' + name + '"]'); }
  function goTo(el) {
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.pageYOffset - 140;
    window.scrollTo(0, Math.max(0, top));
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  }
  function fieldErrors(map) {
    var first = null, list = [];
    Object.keys(map || {}).forEach(function (name) {
      var el = fieldEl(name), q = el && (el.closest('[data-q]') || el.parentNode);
      if (!el) return;
      var msg = document.createElement('span'); msg.className = 'field-err'; msg.textContent = map[name];
      var els = $('fm-steps').querySelectorAll('[data-field="' + name + '"]'); for (var i = 0; i < els.length; i++) els[i].setAttribute('aria-invalid', 'true');
      q.appendChild(msg);
      list.push(name);
      if (!first || (first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) first = el;
    });
    if (list.length > 1) {
      var ul = document.createElement('ul'); ul.className = 'err-links';
      list.forEach(function (n) {
        var li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button'; b.className = 'linkbtn'; b.textContent = 'Go to: ' + ((fields[n] && fields[n].f.label) || n);
        b.onclick = function () { var s = stepOf(n); if (s >= 0 && s !== at) goStep(s, true); goTo(fieldEl(n)); };
        li.appendChild(b); ul.appendChild(li);
      });
      $('fm-err').appendChild(ul);
    }
    goTo(first);
  }
  // a line that was marked as missing loses its note as soon as it is answered
  function unmark(e) {
    var name = e.target && e.target.getAttribute && e.target.getAttribute('data-field');
    if (!name || !e.target.hasAttribute('aria-invalid')) return;
    var els = $('fm-steps').querySelectorAll('[data-field="' + name + '"]');
    for (var i = 0; i < els.length; i++) els[i].removeAttribute('aria-invalid');
    var q = els[0] && els[0].closest('[data-q]'), m = q && q.querySelector('.field-err'); if (m) m.remove();
  }

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'fm-news') newsWanted = !!e.target.checked;
    if (e.target && e.target.closest && e.target.closest('#fm-steps')) followUps();
  });
  $('fm-steps').addEventListener('input', unmark);
  $('fm-steps').addEventListener('change', unmark);
  document.addEventListener('click', function (e) {
    var r = e.target.closest && e.target.closest('[data-read]');
    if (r) readDoc(r.getAttribute('data-read'));
  });
  $('fm-next').addEventListener('click', next);
  $('fm-prev').addEventListener('click', function () { if (at > 0) goStep(at - 1); });
  $('fm-back').addEventListener('click', function () { show('fm-doc', false); show('fm-wiz', true); goStep(at, true); window.scrollTo(0, 0); });

  if (!token) { setState('This page opens from your private link. Please use the link in your email, or ask us for a new one.'); return; }
  api('').then(function (r) {
    if (r.status !== 200 || !r.json || !r.json.success) { setState((r.json && r.json.error) || 'We could not open this link. Please try again later.'); return; }
    packet = r.json;
    render();
  }).catch(function () { setState('We could not reach the server. Please check your connection and try again.'); });
})();
