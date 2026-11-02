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

  function renderIntro() {
    var n = packet.docs.length, done = packet.docs.filter(function (d) { return d.status === 'signed'; }).length;
    var nowDoc = nextPending();
    var h = '<p class="lead">Hello' + (firstName() ? ' ' + esc(firstName()) : '') + '. ' +
      (packet.kind === 'organizer' ? 'This is the group contract for you to read and sign.' : 'Here is your paperwork for this trip. Please read each document and sign it with your full name.') + '</p>' + tripBox();
    h += '<p class="fine">' + done + ' of ' + n + ' signed.' + (nowDoc ? '' : ' Everything is done.') + '</p><ol class="progress">';
    packet.docs.forEach(function (d) {
      var isNow = nowDoc && nowDoc.key === d.key;
      h += '<li' + (isNow ? ' class="now"' : '') + '><span class="t">' + esc(d.title) + '</span>' +
        (d.status === 'signed' ? '<span class="chip done">Signed</span>' : isNow ? '<button type="button" class="linkbtn" data-open="' + esc(d.key) + '">Continue</button>' : '<button type="button" class="linkbtn" data-open="' + esc(d.key) + '">Open</button>') + '</li>';
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
  }

  function openDoc(key) {
    var doc = docByKey(key);
    if (!doc || doc.status === 'signed') return;
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
      (packet.kind === 'organizer' ? 'Mark will add the agent signature and be in touch. ' : 'There is nothing more to do right now. We will contact you if anything is missing or changes. ') +
      'You can close this page; opening your link again shows what is signed.</p>' + tripBox() +
      '<p class="fine">Questions? ' + esc(packet.business ? packet.business.contact : '') + '</p>';
    show('fm-done', true);
    window.scrollTo(0, 0);
  }

  function render() {
    setState('');
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
    var saved = answers;
    busy = true; $('fm-go').disabled = true; $('fm-go').textContent = 'Saving…';
    api('/sign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_key: current.key, signer_name: name, agreed: true, content_sha256: current.text_sha256, answers: answers, newsletter_opt_in: !!(news && news.checked), website: $('fm-website').value })
    }).then(function (r) {
      busy = false; $('fm-go').textContent = 'Sign and continue'; $('fm-go').disabled = false;
      var j = r.json || {};
      if (r.status === 200 && j.success) {
        if (j.packet) packet = j.packet; else return reload();
        var nxt = nextPending();
        if (nxt) { renderIntro(); openDoc(nxt.key); } else showDone();
        return;
      }
      if (r.status === 409 && j.code === 'document-changed') { return reload(true, saved, j.error); }
      if (r.status === 409 && j.code === 'already-signed') { return reload(); }
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
    var b = e.target.closest && e.target.closest('[data-open]');
    if (b) openDoc(b.getAttribute('data-open'));
  });
  $('fm-go').addEventListener('click', sign);
  $('fm-back').addEventListener('click', function () { current = null; show('fm-doc', false); renderIntro(); window.scrollTo(0, 0); });

  if (!token) { setState('This page opens from your private link. Please use the link in your email, or ask us for a new one.'); return; }
  api('').then(function (r) {
    if (r.status !== 200 || !r.json || !r.json.success) { setState((r.json && r.json.error) || 'We could not open this link. Please try again later.'); return; }
    packet = r.json;
    render();
  }).catch(function () { setState('We could not reach the server. Please check your connection and try again.'); });
})();
