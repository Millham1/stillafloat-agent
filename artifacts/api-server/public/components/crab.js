// Still Afloat — Crab Mascot v2
// SVG crab with independently animated body parts for each emotion state.
// Self-contained IIFE — no external image dependencies, no white box.
(function () {
  'use strict';

  const IS_SPANISH = window.location.pathname.startsWith('/es/') || window.location.pathname === '/es';
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const LINES_EN = [
    "I pinched a deal for you! 🦀",
    "Still Afloat… barely!",
    "Cruisin' is my cardio.",
    "Don't be crabby — go cruise!",
    "Ship happens. Stay Afloat!",
    "I've got my EYE on that horizon.",
    "Sand between my claws… paradise.",
    "Catch me on the Lido deck!",
    "Claw enforcement: cruise edition.",
    "Have you tried the buffet? 🦞"
  ];

  const LINES_ES = [
    "¡Te encontré una oferta! 🦀",
    "¡Seguimos a flote… por poco!",
    "Crucerar es mi cardio.",
    "¡No seas tan cangrejo — crucera!",
    "¡Pasan barcos. ¡Mantente a flote!",
    "Tengo el OJO en el horizonte.",
    "¡Arena entre las pinzas… paraíso!",
    "¡Nos vemos en la cubierta Lido!",
    "Ley de la pinza: edición crucero.",
    "¿Probaste el bufé? 🦞"
  ];

  const EMOTIONS = ['waving', 'surprised', 'dancing', 'sleeping', 'bored'];

  // ── Inline SVG crab character ──────────────────────────────────────────────
  // Body parts are in named groups so CSS can target them independently.
  const CRAB_SVG = `<svg id="sa-crab-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 180" width="130" height="107" aria-hidden="true">
  <defs>
    <radialGradient id="cg-body" cx="45%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#ff7a30"/>
      <stop offset="100%" stop-color="#cc3000"/>
    </radialGradient>
    <radialGradient id="cg-belly" cx="50%" cy="40%" r="55%">
      <stop offset="0%" stop-color="#ffe0b0"/>
      <stop offset="100%" stop-color="#ffb870"/>
    </radialGradient>
    <radialGradient id="cg-claw" cx="40%" cy="35%" r="60%">
      <stop offset="0%" stop-color="#ff8540"/>
      <stop offset="100%" stop-color="#c82800"/>
    </radialGradient>
    <filter id="cg-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="rgba(0,0,0,0.28)"/>
    </filter>
  </defs>

  <!-- Ground shadow -->
  <ellipse cx="110" cy="170" rx="52" ry="8" fill="rgba(0,0,0,0.18)"/>

  <!-- Left legs -->
  <g id="sa-legs-left">
    <line x1="72" y1="138" x2="50" y2="155" stroke="#cc3000" stroke-width="6" stroke-linecap="round"/>
    <line x1="65" y1="130" x2="38" y2="143" stroke="#cc3000" stroke-width="6" stroke-linecap="round"/>
    <line x1="60" y1="120" x2="32" y2="128" stroke="#cc3000" stroke-width="6" stroke-linecap="round"/>
    <circle cx="50" cy="155" r="4" fill="#b02000"/>
    <circle cx="38" cy="143" r="4" fill="#b02000"/>
    <circle cx="32" cy="128" r="4" fill="#b02000"/>
  </g>

  <!-- Right legs -->
  <g id="sa-legs-right">
    <line x1="148" y1="138" x2="170" y2="155" stroke="#cc3000" stroke-width="6" stroke-linecap="round"/>
    <line x1="155" y1="130" x2="182" y2="143" stroke="#cc3000" stroke-width="6" stroke-linecap="round"/>
    <line x1="160" y1="120" x2="188" y2="128" stroke="#cc3000" stroke-width="6" stroke-linecap="round"/>
    <circle cx="170" cy="155" r="4" fill="#b02000"/>
    <circle cx="182" cy="143" r="4" fill="#b02000"/>
    <circle cx="188" cy="128" r="4" fill="#b02000"/>
  </g>

  <!-- Left claw group — rotates from shoulder (76, 100) -->
  <g id="sa-claw-left" style="transform-origin:76px 100px; transform-box:fill-box">
    <!-- arm -->
    <path d="M76,100 Q52,85 40,70" stroke="#cc3000" stroke-width="14" stroke-linecap="round" fill="none"/>
    <!-- claw upper -->
    <ellipse cx="32" cy="58" rx="22" ry="13" fill="url(#cg-claw)" transform="rotate(-30,32,58)"/>
    <!-- claw lower -->
    <ellipse cx="28" cy="74" rx="17" ry="10" fill="url(#cg-claw)" transform="rotate(15,28,74)"/>
    <!-- claw highlight -->
    <ellipse cx="28" cy="54" rx="8" ry="4" fill="rgba(255,160,80,0.5)" transform="rotate(-30,28,54)"/>
  </g>

  <!-- Right claw group — rotates from shoulder (144, 100) -->
  <g id="sa-claw-right" style="transform-origin:144px 100px; transform-box:fill-box">
    <!-- arm -->
    <path d="M144,100 Q168,85 180,70" stroke="#cc3000" stroke-width="14" stroke-linecap="round" fill="none"/>
    <!-- claw upper -->
    <ellipse cx="188" cy="58" rx="22" ry="13" fill="url(#cg-claw)" transform="rotate(30,188,58)"/>
    <!-- claw lower -->
    <ellipse cx="192" cy="74" rx="17" ry="10" fill="url(#cg-claw)" transform="rotate(-15,192,74)"/>
    <!-- claw highlight -->
    <ellipse cx="192" cy="54" rx="8" ry="4" fill="rgba(255,160,80,0.5)" transform="rotate(30,192,54)"/>
  </g>

  <!-- Body -->
  <g id="sa-body" filter="url(#cg-shadow)">
    <ellipse cx="110" cy="118" rx="58" ry="48" fill="url(#cg-body)"/>
    <!-- belly / lighter underside -->
    <ellipse cx="110" cy="132" rx="36" ry="26" fill="url(#cg-belly)"/>
    <!-- body shine -->
    <ellipse cx="96" cy="100" rx="16" ry="10" fill="rgba(255,200,140,0.38)" transform="rotate(-20,96,100)"/>
  </g>

  <!-- Left eye group — scales from center for surprised -->
  <g id="sa-eye-left" style="transform-origin:90px 98px; transform-box:fill-box">
    <circle cx="90" cy="98" r="16" fill="white"/>
    <circle cx="90" cy="98" r="16" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="1"/>
    <circle id="sa-pupil-l" cx="92" cy="100" r="9" fill="#1a1a1a"/>
    <circle cx="96" cy="95" r="3.5" fill="white"/>
    <!-- eyelid for sleeping/bored -->
    <rect id="sa-lid-l" x="74" y="88" width="32" height="0" fill="#e05020" rx="4"/>
  </g>

  <!-- Right eye group -->
  <g id="sa-eye-right" style="transform-origin:130px 98px; transform-box:fill-box">
    <circle cx="130" cy="98" r="16" fill="white"/>
    <circle cx="130" cy="98" r="16" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="1"/>
    <circle id="sa-pupil-r" cx="132" cy="100" r="9" fill="#1a1a1a"/>
    <circle cx="136" cy="95" r="3.5" fill="white"/>
    <rect id="sa-lid-r" x="114" y="88" width="32" height="0" fill="#e05020" rx="4"/>
  </g>

  <!-- Mouth — open happy by default -->
  <g id="sa-mouth">
    <path id="sa-mouth-path" d="M98,118 Q110,130 122,118" stroke="#cc2200" stroke-width="3.5" fill="rgba(220,60,40,0.85)" stroke-linecap="round"/>
    <!-- tongue -->
    <ellipse id="sa-tongue" cx="110" cy="124" rx="7" ry="4" fill="#ff6680"/>
  </g>

  <!-- Antennae -->
  <line x1="96" y1="82" x2="84" y2="62" stroke="#cc3000" stroke-width="3" stroke-linecap="round"/>
  <circle cx="84" cy="60" r="4" fill="#ff5020"/>
  <line x1="124" y1="82" x2="136" y2="62" stroke="#cc3000" stroke-width="3" stroke-linecap="round"/>
  <circle cx="136" cy="60" r="4" fill="#ff5020"/>
</svg>`;

  // ── CSS ────────────────────────────────────────────────────────────────────
  const CSS = `
#sa-crab-stage {
  position: fixed;
  bottom: 0;
  right: 24px;
  z-index: 99998;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  transform: translateY(110%);
  transition: transform 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
  will-change: transform;
}
#sa-crab-stage.sa-visible {
  transform: translateY(8px);
}
#sa-crab-stage.sa-exit {
  transform: translateY(110%);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.6, 1);
}
@media (max-width: 600px) {
  #sa-crab-stage { right: 10px; }
  #sa-crab-svg { width: 90px !important; height: auto !important; }
}

/* ── Bubble ── */
#sa-bubble {
  background: #fff;
  color: #07183f;
  font-family: 'Baloo 2', 'Segoe UI', sans-serif;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
  padding: 9px 14px;
  border-radius: 16px;
  border: 2px solid #ffca4f;
  box-shadow: 0 6px 20px rgba(0,0,0,0.22);
  max-width: 190px;
  text-align: center;
  margin-bottom: 6px;
  opacity: 0;
  transform: scale(0.7) translateY(8px);
  transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
  pointer-events: none;
  position: relative;
}
#sa-bubble::after {
  content: '';
  position: absolute;
  bottom: -9px;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: #ffca4f;
}
#sa-bubble.sa-bubble-on {
  opacity: 1;
  transform: scale(1) translateY(0);
}

/* ── Wrapper for click target ── */
#sa-crab-wrap {
  cursor: pointer;
  pointer-events: all;
  position: relative;
  display: inline-block;
}

/* ── zzz elements ── */
.sa-zzz {
  position: absolute;
  top: 8px;
  right: 0px;
  color: #5dff9a;
  font-weight: 900;
  font-size: 15px;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  animation: sa-zzz-float 2.4s ease-in-out infinite;
}
.sa-zzz:nth-child(2) { font-size: 11px; right: 6px; top: 18px; animation-delay: 0.8s; }
.sa-zzz:nth-child(3) { font-size: 7px; right: 10px; top: 26px; animation-delay: 1.6s; }
@keyframes sa-zzz-float {
  0%   { opacity: 0; transform: translate(0,0) scale(0.5); }
  15%  { opacity: 1; }
  85%  { opacity: 0.5; }
  100% { opacity: 0; transform: translate(6px,-24px) scale(1); }
}

/* ═══ EMOTION ANIMATIONS ═══════════════════════════════════════════════════ */

/* WAVING — right claw waves up and down */
@keyframes sa-wave-claw { 0%,100%{transform:rotate(0deg)} 30%{transform:rotate(-35deg)} 60%{transform:rotate(10deg)} 80%{transform:rotate(-20deg)} }
@keyframes sa-wave-body { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
.sa-waving #sa-claw-right { animation: sa-wave-claw 0.9s ease-in-out infinite; }
.sa-waving #sa-body       { animation: sa-wave-body 0.9s ease-in-out infinite; }

/* SURPRISED — eyes pop wide, both claws shoot up, body jumps */
@keyframes sa-surp-eyes  { 0%{transform:scale(1)} 20%{transform:scale(1.45)} 50%{transform:scale(1.3)} 100%{transform:scale(1.3)} }
@keyframes sa-surp-claw-l{ 0%{transform:rotate(0deg)} 20%{transform:rotate(35deg)} 100%{transform:rotate(25deg)} }
@keyframes sa-surp-claw-r{ 0%{transform:rotate(0deg)} 20%{transform:rotate(-35deg)} 100%{transform:rotate(-25deg)} }
@keyframes sa-surp-body  { 0%{transform:translateY(0)} 15%{transform:translateY(-12px)} 30%{transform:translateY(2px)} 100%{transform:translateY(0)} }
.sa-surprised #sa-eye-left  { animation: sa-surp-eyes 0.5s ease-out forwards; }
.sa-surprised #sa-eye-right { animation: sa-surp-eyes 0.5s ease-out forwards; }
.sa-surprised #sa-claw-left { animation: sa-surp-claw-l 0.5s ease-out forwards; }
.sa-surprised #sa-claw-right{ animation: sa-surp-claw-r 0.5s ease-out forwards; }
.sa-surprised #sa-body      { animation: sa-surp-body 0.5s ease-out forwards; }

/* DANCING — body sways side to side, claws alternate */
@keyframes sa-dance-body   { 0%,100%{transform:translateX(0) rotate(0deg)} 25%{transform:translateX(-8px) rotate(-5deg)} 75%{transform:translateX(8px) rotate(5deg)} }
@keyframes sa-dance-claw-l { 0%,100%{transform:rotate(0deg)} 25%{transform:rotate(25deg)} 75%{transform:rotate(-10deg)} }
@keyframes sa-dance-claw-r { 0%,100%{transform:rotate(0deg)} 25%{transform:rotate(-10deg)} 75%{transform:rotate(-25deg)} }
@keyframes sa-dance-eye    { 0%,100%{transform:scale(1)} 50%{transform:scale(1.15)} }
.sa-dancing #sa-body       { animation: sa-dance-body 0.7s ease-in-out infinite; }
.sa-dancing #sa-claw-left  { animation: sa-dance-claw-l 0.7s ease-in-out infinite; }
.sa-dancing #sa-claw-right { animation: sa-dance-claw-r 0.7s ease-in-out infinite; }
.sa-dancing #sa-eye-left   { animation: sa-dance-eye 0.7s ease-in-out infinite; }
.sa-dancing #sa-eye-right  { animation: sa-dance-eye 0.7s 0.35s ease-in-out infinite; }

/* SLEEPING — slow breathe, claws droop down */
@keyframes sa-sleep-body   { 0%,100%{transform:translateY(0) scaleX(1)} 50%{transform:translateY(3px) scaleX(1.04)} }
@keyframes sa-sleep-claw-l { 0%,100%{transform:rotate(-20deg)} 50%{transform:rotate(-25deg)} }
@keyframes sa-sleep-claw-r { 0%,100%{transform:rotate(20deg)} 50%{transform:rotate(25deg)} }
.sa-sleeping #sa-body      { animation: sa-sleep-body 3s ease-in-out infinite; }
.sa-sleeping #sa-claw-left { animation: sa-sleep-claw-l 3s ease-in-out infinite; }
.sa-sleeping #sa-claw-right{ animation: sa-sleep-claw-r 3s ease-in-out infinite; }

/* BORED — slow tilt, one eye half-shut (via lid height), occasional twitch */
@keyframes sa-bored-body  { 0%,70%,100%{transform:rotate(0deg) translateY(0)} 80%{transform:rotate(-4deg) translateY(2px)} 90%{transform:rotate(2deg)} }
@keyframes sa-bored-claw-l{ 0%,100%{transform:rotate(-12deg)} 50%{transform:rotate(-16deg)} }
@keyframes sa-bored-claw-r{ 0%,100%{transform:rotate(8deg)} 50%{transform:rotate(12deg)} }
.sa-bored #sa-body        { animation: sa-bored-body 4s ease-in-out infinite; }
.sa-bored #sa-claw-left   { animation: sa-bored-claw-l 4s ease-in-out infinite; }
.sa-bored #sa-claw-right  { animation: sa-bored-claw-r 4s ease-in-out infinite; }

/* GOODBYE WAVE (exit) */
@keyframes sa-bye-claw    { 0%,100%{transform:rotate(0deg)} 25%{transform:rotate(-40deg)} 60%{transform:rotate(5deg)} }
@keyframes sa-bye-body    { 0%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
.sa-bye #sa-claw-right    { animation: sa-bye-claw 0.6s ease-in-out 2; }
.sa-bye #sa-body          { animation: sa-bye-body 0.6s ease-in-out 2; }
`;

  // ── helpers ────────────────────────────────────────────────────────────────
  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

  let stage, wrap, bubble, zzzEls = [], hideTimer, reappearTimer;

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function build() {
    stage = document.createElement('div');
    stage.id = 'sa-crab-stage';

    bubble = document.createElement('div');
    bubble.id = 'sa-bubble';
    stage.appendChild(bubble);

    wrap = document.createElement('div');
    wrap.id = 'sa-crab-wrap';
    wrap.innerHTML = CRAB_SVG;
    wrap.addEventListener('click', onCrabClick);
    stage.appendChild(wrap);

    document.body.appendChild(stage);
  }

  function clearZzz() {
    zzzEls.forEach(el => el.remove());
    zzzEls = [];
  }

  function setEmotion(name) {
    // Remove all emotion classes
    ['sa-waving','sa-surprised','sa-dancing','sa-sleeping','sa-bored','sa-bye']
      .forEach(c => stage.classList.remove(c));
    clearZzz();

    if (REDUCED) return;
    if (name) stage.classList.add('sa-' + name);

    if (name === 'sleeping') {
      ['z','z','z'].forEach((_, i) => {
        const z = document.createElement('span');
        z.className = 'sa-zzz';
        z.textContent = 'z';
        z.style.animationDelay = (i * 0.8) + 's';
        wrap.appendChild(z);
        zzzEls.push(z);
      });
    }
  }

  function showBubble(text) {
    bubble.textContent = text;
    bubble.classList.add('sa-bubble-on');
  }

  function hideBubble() {
    bubble.classList.remove('sa-bubble-on');
  }

  function appear() {
    setEmotion(rand(EMOTIONS));
    hideBubble();
    stage.classList.remove('sa-exit');
    void stage.offsetWidth; // reflow
    stage.classList.add('sa-visible');

    clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, randInt(6000, 9000));
  }

  function dismiss() {
    clearTimeout(hideTimer);
    hideBubble();
    setEmotion('bye');
    setTimeout(() => {
      stage.classList.remove('sa-visible');
      stage.classList.add('sa-exit');
      clearZzz();
      scheduleReappear();
    }, REDUCED ? 0 : 900);
  }

  function scheduleReappear() {
    clearTimeout(reappearTimer);
    reappearTimer = setTimeout(appear, randInt(25000, 50000));
  }

  function onCrabClick(e) {
    e.stopPropagation();
    clearTimeout(hideTimer);
    setEmotion('surprised');
    showBubble(rand(IS_SPANISH ? LINES_ES : LINES_EN));
    hideTimer = setTimeout(dismiss, 3500);
  }

  function init() {
    injectStyles();
    build();
    reappearTimer = setTimeout(appear, randInt(4000, 10000));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
