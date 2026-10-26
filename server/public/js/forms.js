// forms.js — the traveler's private paperwork page (server/public/forms.html).
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
  var packet = null, current = null, busy = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function show(id, on) { $(id).hidden = !on; }
  function setState(msg) { $('fm-state').textContent = msg || ''; show('fm-state', !!msg); }
  function api(path, opts) {
    return fetch(API_BASE + encodeURIComponent(token) + (path || ''), opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; });
    });
  }

  // Mark 2026-10-26: what is typed in a document stays if the client leaves and comes back, until that document is signed (js/keep-typing.js).
  function keepKey(docKey) { return window.SAKeep ? window.SAKeep.keyFor('forms', token) + ':' + docKey : null; }

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
          if (!x.ok || !x.j.available) { look.off = true; say(esc(ADDR.na)); return; }
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
    function typed() { if (look.off) return; say(''); clearTimeout(look.timer); look.timer = setTimeout(ask, 500); }
    street.addEventListener('input', typed); csz.addEventListener('input', typed);
    if (tidy(street.value) && tidy(csz.value)) typed();
  }

  function firstName() { return (packet && packet.traveler && packet.traveler.first_name) || ''; }
  function docByKey(k) { for (var i = 0; i < packet.docs.length; i++) if (packet.docs[i].key === k) return packet.docs[i]; return null; }
  function nextPending() { for (var i = 0; i < packet.docs.length; i++) if (packet.docs[i].status !== 'signed') return packet.docs[i]; return null; }

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
  function consentCard() {
    var c = packet.esign.text;
    return '<section class="sign esign" id="fm-consent" aria-labelledby="fm-consent-h"><h3 id="fm-consent-h">' + esc(c.title) + '</h3>' +
      '<p>' + esc(c.intro) + '</p><ul>' + c.points.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<label class="agree"><input type="checkbox" id="fm-esign"><span>' + esc(c.tick) + '</span></label>' +
      '<div id="fm-esign-err" class="err-box" role="alert" hidden></div>' +
      '<button type="button" class="btn" id="fm-esign-go">' + esc(c.button) + '</button></section>';
  }
  function giveConsent() {
    if (busy) return;
    var err = $('fm-esign-err'); err.hidden = true;
    if (!$('fm-esign').checked) { err.textContent = 'Please tick the box to agree to signing electronically.'; err.hidden = false; return; }
    busy = true; $('fm-esign-go').disabled = true;
    api('/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agreed: true, website: ($('fm-website') || {}).value || '' }) })
      .then(function (r) {
        busy = false;
        var j = r.json || {};
        if (r.status === 200 && j.success && j.packet) { packet = j.packet; var nxt = nextPending(); if (nxt) { renderIntro(); openDoc(nxt.key); } else render(); return; }
        $('fm-esign-go').disabled = false; err.textContent = j.error || 'That did not go through. Please try again.'; err.hidden = false;
      }).catch(function () { busy = false; $('fm-esign-go').disabled = false; err.textContent = 'We could not reach the server. Please check your connection and try again.'; err.hidden = false; });
  }

  function renderIntro() {
    var n = packet.docs.length, done = packet.docs.filter(function (d) { return d.status === 'signed'; }).length;
    var nowDoc = nextPending();
    var h = '<p class="lead">Hello' + (firstName() ? ' ' + esc(firstName()) : '') + '. ' +
      (packet.kind === 'organizer' ? 'This is the group contract for you to read and sign.' : 'Here is your paperwork for this trip. Please read each document and sign it with your full name.') + '</p>' +
      (consented() ? '' : consentCard()) + tripBox();
    h += '<p class="fine">' + done + ' of ' + n + ' signed.' + (nowDoc ? '' : ' Everything is done.') + '</p><ol class="progress">';
    packet.docs.forEach(function (d) {
      var isNow = nowDoc && nowDoc.key === d.key;
      h += '<li' + (isNow ? ' class="now"' : '') + '><span class="t">' + esc(d.title) + '</span>' +
        (d.status === 'signed' ? '<span class="chip done">Signed</span>' : !consented() ? '<span class="chip">Opens after the box above</span>' : isNow ? '<button type="button" class="linkbtn" data-open="' + esc(d.key) + '">Continue</button>' : '<button type="button" class="linkbtn" data-open="' + esc(d.key) + '">Open</button>') + '</li>';
    });
    h += '</ol>';
    $('fm-intro').innerHTML = h;
    show('fm-intro', true);
  }

  function setValue(name, value) {
    var els = $('fm-doc-body').querySelectorAll('[data-field="' + name + '"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.type === 'radio') el.checked = (el.value === value);
      else if (el.type === 'checkbox') el.checked = Array.isArray(value) ? value.indexOf(el.value) >= 0 : value === true;
      else el.value = value == null ? '' : String(value);
    }
  }

  function wireDoc(doc) {
    var body = $('fm-doc-body');
    body.innerHTML = doc.html;
    doc.fields.forEach(function (f) {
      var els = body.querySelectorAll('[data-field="' + f.name + '"]');
      for (var i = 0; i < els.length; i++) { if (f.required && (els[i].type === 'text' || els[i].tagName === 'TEXTAREA' || els[i].type === 'date' || els[i].type === 'email' || els[i].type === 'tel')) els[i].classList.add('req'); }
      if (f.value !== null && f.value !== undefined && f.value !== '') setValue(f.name, f.value);
    });
    show('fm-legend', doc.fields.some(function (f) { return f.required; }));
    // passport: say what is on file, and stop short when this box cannot keep a passport number safely
    var pp = body.querySelector('[data-field="passport_number"]');
    if (pp) {
      var note = document.createElement('div'); note.className = 'passport-note';
      if (!packet.pii_ready) { pp.disabled = true; note.textContent = 'We cannot take a passport number on this page right now. Please leave it empty; we will ask for it another way.'; }
      else if (packet.traveler && packet.traveler.passport_on_file) note.textContent = 'A passport ' + packet.traveler.passport_on_file + ' is already on file. Type the number again only if it has changed.';
      else note.textContent = 'Your passport number is stored encrypted and is never shown again, not even to you.';
      pp.parentNode.insertBefore(note, pp.nextSibling);
    }
    // extra choice that belongs to the form, not to the signed text: the newsletter
    var extra = $('fm-extra'); extra.innerHTML = '';
    if (doc.key === '15-emergency-contact-form' && packet.kind === 'traveler' && !(packet.traveler && packet.traveler.newsletter_opt_in)) {
      extra.innerHTML = '<label class="agree"><input type="checkbox" id="fm-news"><span>Send me the Still Afloat Cruising newsletter. (Optional. You can unsubscribe at any time.)</span></label>';
    }
    $('fm-agree').checked = false;
    $('fm-go').disabled = false;
    hideErr();
    addressCheck(body);
    if (window.SAKeep) window.SAKeep.restore($('fm-doc'), keepKey(doc.key));
  }

  function openDoc(key) {
    var doc = docByKey(key);
    if (!doc || doc.status === 'signed') return;
    if (!consented()) { var cc = $('fm-consent'); if (cc) cc.scrollIntoView({ block: 'center' }); return; }
    current = doc;
    show('fm-intro', false); show('fm-done', false); show('fm-doc', true);
    $('fm-doc-title').textContent = doc.title;
    wireDoc(doc);
    window.scrollTo(0, 0);
    $('fm-doc-title').focus();
  }

  function showDone() {
    current = null;
    show('fm-intro', false); show('fm-doc', false);
    var who = firstName();
    $('fm-done').innerHTML = '<h2>Thank you' + (who ? ', ' + esc(who) : '') + '.</h2>' +
      '<p class="lead">' + (packet.kind === 'organizer' ? 'Your group contract is signed.' : 'Your paperwork is complete.') + '</p>' +
      '<p>A signed copy of each document is kept on file with ' + esc(packet.business ? packet.business.name : 'us') + '. ' +
      (packet.copies_sent_at ? 'We have also emailed you your own copy of each signed document. ' : '') +
      (packet.kind === 'organizer' ? 'Mark will add the agent signature and be in touch. ' : 'There is nothing more to do right now. We will contact you if anything is missing or changes. ') +
      'You can close this page; opening your link again shows what is signed.</p>' + tripBox() +
      '<p class="fine">Questions? ' + esc(packet.business ? packet.business.contact : '') + '</p>';
    show('fm-done', true);
    window.scrollTo(0, 0);
  }

  // Mark 2026-10-26: the page opens on the trip's own photos (left, middle, right, tilted), never the website's banner. Each private page
  // shows a different selling point; the group file says which (groups.journey.photos), and a missing one is simply left out.
  function photos() {
    if (window.SATripPhotos) window.SATripPhotos.render($('fm-photos'), packet.group && packet.group.photos);
  }

  function render() {
    setState('');
    photos();
    $('fm-foot').textContent = (packet.business && packet.business.name) || 'Still Afloat Cruising';
    if (packet.docs.length && !nextPending()) showDone(); else renderIntro();
  }

  function showErr(msg) { var e = $('fm-err'); e.textContent = msg; e.hidden = false; }
  function hideErr() {
    $('fm-err').hidden = true;
    var errs = $('fm-doc').querySelectorAll('.field-err'); for (var i = 0; i < errs.length; i++) errs[i].remove();
    var bad = $('fm-doc').querySelectorAll('[aria-invalid]'); for (var j = 0; j < bad.length; j++) bad[j].removeAttribute('aria-invalid');
  }

  function collect(doc) {
    var body = $('fm-doc-body'), out = {};
    doc.fields.forEach(function (f) {
      var els = body.querySelectorAll('[data-field="' + f.name + '"]');
      if (!els.length) return;
      if (f.kind === 'choice') { for (var i = 0; i < els.length; i++) if (els[i].checked) out[f.name] = els[i].value; }
      else if (f.kind === 'multi') { var vals = []; for (var k = 0; k < els.length; k++) if (els[k].checked) vals.push(els[k].value); out[f.name] = vals; }
      else if (f.kind === 'check') { out[f.name] = !!els[0].checked; }
      else if (!els[0].disabled) { var v = els[0].value.trim(); if (v) out[f.name] = v; }
    });
    return out;
  }

  function fieldErrors(map) {
    var first = null;
    Object.keys(map || {}).forEach(function (name) {
      var els = $('fm-doc-body').querySelectorAll('[data-field="' + name + '"]');
      if (!els.length) return;
      var host = els[0], msg = document.createElement('span');
      msg.className = 'field-err'; msg.textContent = map[name];
      for (var i = 0; i < els.length; i++) els[i].setAttribute('aria-invalid', 'true');
      var anchor = els[els.length - 1];
      if (anchor.type === 'checkbox' || anchor.type === 'radio') { (anchor.closest('p,li,td,th') || anchor.parentNode).appendChild(msg); }
      else anchor.parentNode.insertBefore(msg, anchor.nextSibling);
      if (!first) first = host;
    });
    if (first) { first.scrollIntoView({ block: 'center' }); try { first.focus(); } catch (e) {} }
  }

  function sign() {
    if (busy || !current) return;
    hideErr();
    if (!$('fm-agree').checked) { showErr('Please tick the box to say you have read this document and agree to it.'); return; }
    var name = $('fm-name').value.replace(/\s+/g, ' ').trim();
    if (name.split(' ').length < 2) { showErr('Please type your full name (first and last) as your signature.'); $('fm-name').focus(); return; }
    var answers = collect(current), news = $('fm-news');
    var saved = answers, signing = current.key;
    busy = true; $('fm-go').disabled = true; $('fm-go').textContent = 'Saving…';
    api('/sign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_key: current.key, signer_name: name, agreed: true, content_sha256: current.text_sha256, answers: answers, newsletter_opt_in: !!(news && news.checked), website: $('fm-website').value })
    }).then(function (r) {
      busy = false; $('fm-go').textContent = 'Sign and continue'; $('fm-go').disabled = false;
      var j = r.json || {};
      if (r.status === 200 && j.success) {
        if (window.SAKeep) window.SAKeep.clear(keepKey(signing));
        if (j.packet) packet = j.packet; else return reload();
        var nxt = nextPending();
        if (nxt) { renderIntro(); openDoc(nxt.key); } else showDone();
        return;
      }
      if (r.status === 409 && j.code === 'document-changed') { return reload(true, saved, j.error); }
      if (r.status === 409 && j.code === 'already-signed') { return reload(); }
      if (r.status === 400 && j.code === 'consent-required') { current = null; show('fm-doc', false); return reload(); }
      if (r.status === 404) { setState(j.error || 'This link is not valid.'); show('fm-doc', false); return; }
      showErr(j.error || 'That did not go through. Please try again.');
      fieldErrors(j.fields);
    }).catch(function () {
      busy = false; $('fm-go').textContent = 'Sign and continue'; $('fm-go').disabled = false;
      showErr('We could not reach the server. Please check your connection and try again.');
    });
  }

  function reload(keep, saved, msg) {
    var key = current && current.key;
    return api('').then(function (r) {
      if (r.status !== 200) { setState((r.json && r.json.error) || 'This link is not valid.'); show('fm-doc', false); show('fm-intro', false); return; }
      packet = r.json;
      if (key && docByKey(key) && docByKey(key).status !== 'signed') {
        renderIntro(); openDoc(key);
        if (keep && saved) Object.keys(saved).forEach(function (n) { setValue(n, saved[n]); });
        if (msg) showErr(msg);
      } else render();
    });
  }

  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'fm-esign-go') { giveConsent(); return; }
    var b = e.target.closest && e.target.closest('[data-open]');
    if (b) openDoc(b.getAttribute('data-open'));
  });
  $('fm-go').addEventListener('click', sign);
  if (window.SAKeep) window.SAKeep.track($('fm-doc'), function () { return current ? keepKey(current.key) : null; });
  $('fm-back').addEventListener('click', function () { current = null; show('fm-doc', false); renderIntro(); window.scrollTo(0, 0); });

  if (!token) { setState('This page opens from your private link. Please use the link in your email, or ask us for a new one.'); return; }
  api('').then(function (r) {
    if (r.status !== 200 || !r.json || !r.json.success) { setState((r.json && r.json.error) || 'We could not open this link. Please try again later.'); return; }
    packet = r.json;
    render();
  }).catch(function () { setState('We could not reach the server. Please check your connection and try again.'); });
})();
