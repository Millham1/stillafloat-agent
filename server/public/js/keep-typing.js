// keep-typing.js — what a client types on one of our pages stays there if they move away and come back (Mark's standing rule, 2026-10-26).
// Kept in the client's own browser only (never sent anywhere by this file), under a key made from a short hash of the page's private
// link (never the link itself), for 30 days at most, and cleared by the page once what was typed has been sent or signed.
// Never kept: card numbers, passport numbers, passwords, the bot trap, and any box marked data-nokeep (the "I agree" ticks are given fresh).
// The page calls SAKeep.track(root, getKey) once, SAKeep.restore(root, key) after it has filled in what the server already holds, and
// SAKeep.clear(key) after a send. A restored box fires its own input/change event, so the page's own logic sees it as typed.
(function () {
  'use strict';
  var PREFIX = 'sa-keep:', DAYS = 30;
  var NEVER = /card|cc-|cvv|cvc|passport_number|password|website/i;

  function hash(s) { var h = 5381; s = String(s || ''); for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
  function nameOf(el) { return el.getAttribute('data-field') || el.id || el.name || ''; }
  function keepable(el) {
    var n = nameOf(el), t = String(el.type || '').toLowerCase();
    if (!n || el.disabled || el.hasAttribute('data-nokeep') || (el.closest && el.closest('.hp,[data-nokeep]'))) return false;
    if (t === 'password' || t === 'hidden' || t === 'file' || t === 'submit' || t === 'button') return false;
    return !NEVER.test(n) && !/^cc-/.test(el.getAttribute('autocomplete') || '');
  }
  function controls(root) {
    var all = root ? root.querySelectorAll('input,textarea,select') : [], out = [];
    for (var i = 0; i < all.length; i++) if (keepable(all[i])) out.push(all[i]);
    return out;
  }
  function read(key) {
    try {
      var o = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
      if (!o || typeof o.at !== 'number' || o.at < Date.now() - DAYS * 864e5) { localStorage.removeItem(PREFIX + key); return null; }
      return o.v && typeof o.v === 'object' ? o.v : null;
    } catch (e) { return null; }
  }
  function write(key, v) { try { localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), v: v })); } catch (e) { /* storage off: the page simply works without it */ } }

  /** What the boxes under root hold now: text by name, a radio group by its picked value, a group of ticks as a list, one tick as true/false. */
  function snapshot(root) {
    var els = controls(root), v = {}, count = {};
    els.forEach(function (el) { if (el.type === 'checkbox') count[nameOf(el)] = (count[nameOf(el)] || 0) + 1; });
    els.forEach(function (el) {
      var n = nameOf(el);
      if (el.type === 'radio') { if (el.checked) v[n] = el.value; else if (!(n in v)) v[n] = null; }
      else if (el.type === 'checkbox') {
        if (count[n] > 1) { v[n] = v[n] || []; if (el.checked) v[n].push(el.value); }
        else v[n] = !!el.checked;
      } else v[n] = el.value;
    });
    return v;
  }

  var SAKeep = {
    keyFor: function (page, link) { return page + ':' + hash(link); },
    save: function (root, key) { if (root && key) write(key, snapshot(root)); },
    clear: function (key) { try { if (key) localStorage.removeItem(PREFIX + key); } catch (e) { /* nothing kept */ } },
    /** Put back what was typed under key. true when anything came back. */
    restore: function (root, key) {
      var v = key && read(key);
      if (!v || !root) return false;
      var changed = [];
      controls(root).forEach(function (el) {
        var n = nameOf(el);
        if (!Object.prototype.hasOwnProperty.call(v, n)) return;
        var want = v[n], was;
        if (el.type === 'radio') { was = el.checked; el.checked = want !== null && el.value === want; if (was !== el.checked) changed.push(el); }
        else if (el.type === 'checkbox') { was = el.checked; el.checked = Array.isArray(want) ? want.indexOf(el.value) >= 0 : want === true; if (was !== el.checked) changed.push(el); }
        else if (typeof want === 'string' && el.value !== want) { el.value = want; changed.push(el); }
      });
      changed.forEach(function (el) {
        el.dispatchEvent(new Event(el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      });
      return changed.length > 0;
    },
    /** Keep root's boxes as they are typed. getKey() names where (null = nothing to keep right now). */
    track: function (root, getKey) {
      if (!root || root.getAttribute('data-keep-tracked')) return;
      root.setAttribute('data-keep-tracked', '1');
      var timer = null;
      function later() { clearTimeout(timer); timer = setTimeout(function () { var k = getKey(); if (k) SAKeep.save(root, k); }, 250); }
      root.addEventListener('input', later);
      root.addEventListener('change', later);
      // leaving the page (another tab, the back button, closing): keep what is there that moment
      window.addEventListener('pagehide', function () { var k = getKey(); if (k) SAKeep.save(root, k); });
    },
  };
  window.SAKeep = SAKeep;
})();
