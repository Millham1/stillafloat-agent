// Still Afloat — Crab Mascot v3
// Multiple spawn positions, scuttle-across mode, 7 distinct emotions,
// wider SVG viewBox so claws never clip.
(function () {
  'use strict';

  const IS_SPANISH = window.location.pathname.startsWith('/es/') || window.location.pathname === '/es';
  const REDUCED    = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const LINES_EN = [
    "I pinched a deal for you! 🦀",
    "Still Afloat… barely!",
    "Cruisin' is my cardio.",
    "Don't be crabby — go cruise!",
    "Ship happens. Stay Afloat!",
    "I've got my EYE on that horizon.",
    "Sand between my claws… paradise.",
    "Have you tried the buffet? 🦞",
    "Claw enforcement: cruise edition.",
    "I came sideways — fastest route!",
    "No pinching. Unless you skip dessert.",
    "I walked from Nassau. Worth it.",
  ];
  const LINES_ES = [
    "¡Te encontré una oferta! 🦀",
    "¡Seguimos a flote… por poco!",
    "Crucerar es mi cardio.",
    "¡No seas cangrejo — crucera!",
    "¡Pasan barcos. ¡Mantente a flote!",
    "Tengo el OJO en el horizonte.",
    "Arena entre las pinzas… paraíso.",
    "¿Probaste el bufé? 🦞",
    "Ley de la pinza: edición crucero.",
    "Llegué de lado — la ruta más rápida.",
    "Sin pellizcos. Salvo si saltaste el postre.",
    "Vine caminando desde Nassau. Valió la pena.",
  ];

  // ── Spawn modes ──────────────────────────────────────────────────────────
  // Each entry: { type, weight, emotion, mirrored }
  const SPAWN_MODES = [
    { type: 'corner-right',  weight: 28, emotion: null,      mirrored: false },
    { type: 'corner-left',   weight: 22, emotion: null,      mirrored: true  },
    { type: 'center',        weight: 16, emotion: null,      mirrored: false },
    { type: 'scuttle-lr',    weight: 17, emotion: 'dancing', mirrored: false },
    { type: 'scuttle-rl',    weight: 17, emotion: 'dancing', mirrored: true  },
  ];

  const POPUP_EMOTIONS = ['waving','surprised','happy','excited','bored','sleeping','wow'];

  // ── Inline SVG ───────────────────────────────────────────────────────────
  // viewBox has 30px padding on each side so claws are never clipped.
  const CRAB_SVG = `<svg id="sa-svg" xmlns="http://www.w3.org/2000/svg"
    viewBox="-30 -5 280 195" width="150" height="107"
    style="overflow:visible;display:block" aria-hidden="true">
  <defs>
    <radialGradient id="cg-bd" cx="42%" cy="36%" r="62%">
      <stop offset="0%" stop-color="#ff8040"/>
      <stop offset="100%" stop-color="#c42800"/>
    </radialGradient>
    <radialGradient id="cg-bl" cx="50%" cy="38%" r="58%">
      <stop offset="0%" stop-color="#ffe4b8"/>
      <stop offset="100%" stop-color="#ffb870"/>
    </radialGradient>
    <radialGradient id="cg-cl" cx="38%" cy="32%" r="64%">
      <stop offset="0%" stop-color="#ff8540"/>
      <stop offset="100%" stop-color="#bf2200"/>
    </radialGradient>
  </defs>

  <!-- Shadow -->
  <ellipse cx="110" cy="173" rx="50" ry="7" fill="rgba(0,0,0,0.18)"/>

  <!-- Legs left -->
  <g id="sa-ll">
    <line x1="72" y1="138" x2="48" y2="158" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="64" y1="128" x2="36" y2="144" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="58" y1="117" x2="28" y2="128" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <circle cx="48" cy="158" r="4.5" fill="#a02200"/>
    <circle cx="36" cy="144" r="4.5" fill="#a02200"/>
    <circle cx="28" cy="128" r="4.5" fill="#a02200"/>
  </g>

  <!-- Legs right -->
  <g id="sa-lr">
    <line x1="148" y1="138" x2="172" y2="158" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="156" y1="128" x2="184" y2="144" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="162" y1="117" x2="192" y2="128" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <circle cx="172" cy="158" r="4.5" fill="#a02200"/>
    <circle cx="184" cy="144" r="4.5" fill="#a02200"/>
    <circle cx="192" cy="128" r="4.5" fill="#a02200"/>
  </g>

  <!-- LEFT CLAW — transform-origin at shoulder (78,104) -->
  <g id="sa-cl" style="transform-box:fill-box;transform-origin:78px 104px">
    <path d="M78,104 Q52,86 36,68" stroke="#bf2800" stroke-width="15" stroke-linecap="round" fill="none"/>
    <ellipse cx="24" cy="56" rx="24" ry="14" fill="url(#cg-cl)" transform="rotate(-28,24,56)"/>
    <ellipse cx="20" cy="73" rx="18" ry="11" fill="url(#cg-cl)" transform="rotate(18,20,73)"/>
    <ellipse cx="20" cy="52" rx="9" ry="5" fill="rgba(255,170,90,0.45)" transform="rotate(-28,20,52)"/>
    <path d="M10,62 Q22,48 36,56" stroke="none" fill="rgba(0,0,0,0.12)" transform="rotate(-28,24,56)"/>
  </g>

  <!-- RIGHT CLAW — transform-origin at shoulder (142,104) -->
  <g id="sa-cr" style="transform-box:fill-box;transform-origin:142px 104px">
    <path d="M142,104 Q168,86 184,68" stroke="#bf2800" stroke-width="15" stroke-linecap="round" fill="none"/>
    <ellipse cx="196" cy="56" rx="24" ry="14" fill="url(#cg-cl)" transform="rotate(28,196,56)"/>
    <ellipse cx="200" cy="73" rx="18" ry="11" fill="url(#cg-cl)" transform="rotate(-18,200,73)"/>
    <ellipse cx="200" cy="52" rx="9" ry="5" fill="rgba(255,170,90,0.45)" transform="rotate(28,200,52)"/>
  </g>

  <!-- Body -->
  <g id="sa-body" style="transform-box:fill-box;transform-origin:110px 120px">
    <ellipse cx="110" cy="120" rx="58" ry="50" fill="url(#cg-bd)"
      style="filter:drop-shadow(0 5px 10px rgba(0,0,0,0.32))"/>
    <ellipse cx="110" cy="135" rx="36" ry="28" fill="url(#cg-bl)"/>
    <ellipse cx="95" cy="103" rx="17" ry="11" fill="rgba(255,200,130,0.38)" transform="rotate(-22,95,103)"/>
  </g>

  <!-- Eyes -->
  <g id="sa-el" style="transform-box:fill-box;transform-origin:90px 100px">
    <circle cx="90" cy="100" r="17" fill="white"/>
    <circle cx="92" cy="102" r="10" fill="#111"/>
    <circle cx="97" cy="97"  r="4"  fill="white"/>
    <!-- eyelid (height animated for bored/sleeping) -->
    <rect id="sa-lid-l" x="73" y="89" width="34" height="2" rx="3" fill="#d04820"/>
  </g>
  <g id="sa-er" style="transform-box:fill-box;transform-origin:130px 100px">
    <circle cx="130" cy="100" r="17" fill="white"/>
    <circle cx="132" cy="102" r="10" fill="#111"/>
    <circle cx="137" cy="97"  r="4"  fill="white"/>
    <rect id="sa-lid-r" x="113" y="89" width="34" height="2" rx="3" fill="#d04820"/>
  </g>

  <!-- Mouth -->
  <g id="sa-mouth">
    <path id="sa-mp" d="M96,120 Q110,134 124,120" stroke="#b01800" stroke-width="3.5"
      fill="rgba(200,40,30,0.82)" stroke-linecap="round"/>
    <ellipse id="sa-tongue" cx="110" cy="126" rx="8" ry="5" fill="#ff6080"/>
  </g>

  <!-- Antennae -->
  <line x1="96"  y1="84" x2="82"  y2="62" stroke="#bf2800" stroke-width="3" stroke-linecap="round"/>
  <circle cx="82" cy="60" r="4.5" fill="#ff5020"/>
  <line x1="124" y1="84" x2="138" y2="62" stroke="#bf2800" stroke-width="3" stroke-linecap="round"/>
  <circle cx="138" cy="60" r="4.5" fill="#ff5020"/>
</svg>`;

  // ── CSS ──────────────────────────────────────────────────────────────────
  const CSS = `
/* ── Stage ── */
#sa-stage {
  position: fixed;
  bottom: 0;
  z-index: 99998;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  will-change: transform;
}

/* ── Pop-up positions ── */
#sa-stage.sa-right  { right: 20px; }
#sa-stage.sa-left   { left:  20px; }
#sa-stage.sa-center { left: 50%; }

/* Hidden (slid below fold) */
#sa-stage.sa-right,
#sa-stage.sa-left  { transform: translateY(120%); transition: transform 0.55s cubic-bezier(0.34,1.56,0.64,1); }
#sa-stage.sa-center { transform: translateX(-50%) translateY(120%); transition: transform 0.55s cubic-bezier(0.34,1.56,0.64,1); }

/* Visible */
#sa-stage.sa-right.sa-on  { transform: translateY(6px); }
#sa-stage.sa-left.sa-on   { transform: translateY(6px); }
#sa-stage.sa-center.sa-on { transform: translateX(-50%) translateY(6px); }

/* Exiting */
#sa-stage.sa-right.sa-out  { transform: translateY(120%); transition: transform 0.38s ease-in; }
#sa-stage.sa-left.sa-out   { transform: translateY(120%); transition: transform 0.38s ease-in; }
#sa-stage.sa-center.sa-out { transform: translateX(-50%) translateY(120%); transition: transform 0.38s ease-in; }

/* ── Scuttle positions ── */
#sa-stage.sa-scuttle { bottom: 8px; }
#sa-stage.sa-scuttle-lr { left: 0; transform: translateX(-180px); }
#sa-stage.sa-scuttle-rl { right: 0; transform: translateX(180px); }
#sa-stage.sa-scuttle.sa-on  { animation: none; }

@keyframes sa-go-lr { from { transform:translateX(calc(-200px)) } to { transform:translateX(calc(100vw + 60px)) } }
@keyframes sa-go-rl { from { transform:translateX(calc(100vw + 60px)) } to { transform:translateX(-200px) } }
#sa-stage.sa-scuttle-lr.sa-on { animation: sa-go-lr 10s linear forwards; }
#sa-stage.sa-scuttle-rl.sa-on { animation: sa-go-rl 10s linear forwards; }

/* ── Bubble ── */
#sa-bubble {
  background: #fff;
  color: #07183f;
  font-family: 'Baloo 2','Segoe UI',sans-serif;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
  padding: 9px 14px;
  border-radius: 16px;
  border: 2.5px solid #ffca4f;
  box-shadow: 0 6px 20px rgba(0,0,0,0.22);
  max-width: 185px;
  text-align: center;
  margin-bottom: 6px;
  opacity: 0;
  transform: scale(0.7) translateY(8px);
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34,1.56,0.64,1);
  pointer-events: none;
  position: relative;
}
#sa-bubble::after {
  content:'';
  position:absolute;
  bottom:-9px; left:50%;
  transform:translateX(-50%);
  border:5px solid transparent;
  border-top-color:#ffca4f;
}
#sa-bubble.sa-bon { opacity:1; transform:scale(1) translateY(0); }

/* ── Wrap ── */
#sa-wrap {
  cursor: pointer;
  pointer-events: all;
  position: relative;
  display: inline-block;
  line-height: 0;
}

/* Mirror crab for left-facing directions */
#sa-wrap.sa-flip { transform: scaleX(-1); }

/* Mobile */
@media(max-width:600px){
  #sa-right { right:10px; }
  #sa-left  { left:10px; }
  #sa-svg   { width:100px !important; height:auto !important; }
}

/* ── zzz ── */
.sa-zzz {
  position:absolute;
  top:6px; right:-2px;
  color:#5dff9a;
  font-weight:900; font-size:16px; line-height:1;
  opacity:0; pointer-events:none;
  animation: sa-zf 2.4s ease-in-out infinite;
}
.sa-zzz:nth-child(2){ font-size:11px; right:5px; top:18px; animation-delay:.8s; }
.sa-zzz:nth-child(3){ font-size:7px;  right:9px; top:26px; animation-delay:1.6s; }
@keyframes sa-zf{ 0%{opacity:0;transform:translate(0,0) scale(.5)} 15%{opacity:1} 85%{opacity:.5} 100%{opacity:0;transform:translate(6px,-22px) scale(1)} }

/* ══ EMOTION ANIMATIONS ══════════════════════════════════════════════════ */

/* WAVING — right claw waves, body bobs */
@keyframes kw-cr{ 0%,100%{transform:rotate(0)} 30%{transform:rotate(-38deg)} 65%{transform:rotate(8deg)} 82%{transform:rotate(-22deg)} }
@keyframes kw-bd{ 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
.sa-e-waving #sa-cr  { animation:kw-cr .9s ease-in-out infinite }
.sa-e-waving #sa-body{ animation:kw-bd .9s ease-in-out infinite }

/* HAPPY — both claws up and bouncy, body hops */
@keyframes kh-cl{ 0%,100%{transform:rotate(0)} 50%{transform:rotate(28deg)} }
@keyframes kh-cr{ 0%,100%{transform:rotate(0)} 50%{transform:rotate(-28deg)} }
@keyframes kh-bd{ 0%,100%{transform:translateY(0) scaleY(1)} 40%{transform:translateY(-10px) scaleY(1.05)} 60%{transform:translateY(2px) scaleY(.96)} }
@keyframes kh-el{ 0%,100%{transform:scale(1)} 50%{transform:scale(1.12)} }
.sa-e-happy #sa-cl   { animation:kh-cl 1s ease-in-out infinite }
.sa-e-happy #sa-cr   { animation:kh-cr 1s ease-in-out infinite }
.sa-e-happy #sa-body { animation:kh-bd 1s ease-in-out infinite }
.sa-e-happy #sa-el   { animation:kh-el 1s ease-in-out infinite }
.sa-e-happy #sa-er   { animation:kh-el 1s .5s ease-in-out infinite }

/* SURPRISED / WOW — eyes pop huge, claws fly out, body jumps */
@keyframes ks-eye{ 0%{transform:scale(1)} 20%{transform:scale(1.5)} 100%{transform:scale(1.38)} }
@keyframes ks-cl { 0%{transform:rotate(0)} 20%{transform:rotate(40deg)} 100%{transform:rotate(28deg)} }
@keyframes ks-cr { 0%{transform:rotate(0)} 20%{transform:rotate(-40deg)} 100%{transform:rotate(-28deg)} }
@keyframes ks-bd { 0%{transform:translateY(0)} 15%{transform:translateY(-14px)} 32%{transform:translateY(3px)} 100%{transform:translateY(0)} }
.sa-e-surprised #sa-el,
.sa-e-wow       #sa-el  { animation:ks-eye .5s ease-out forwards }
.sa-e-surprised #sa-er,
.sa-e-wow       #sa-er  { animation:ks-eye .5s ease-out forwards }
.sa-e-surprised #sa-cl,
.sa-e-wow       #sa-cl  { animation:ks-cl .5s ease-out forwards }
.sa-e-surprised #sa-cr,
.sa-e-wow       #sa-cr  { animation:ks-cr .5s ease-out forwards }
.sa-e-surprised #sa-body,
.sa-e-wow       #sa-body{ animation:ks-bd .5s ease-out forwards }

/* WOW — faster, more dramatic version (same keys, shorter duration) */
.sa-e-wow #sa-el   { animation-duration:.35s }
.sa-e-wow #sa-er   { animation-duration:.35s }
.sa-e-wow #sa-body { animation-duration:.35s }

/* DANCING — sway with alternating claws (also used for scuttle) */
@keyframes kd-bd{ 0%,100%{transform:translateX(0) rotate(0)} 25%{transform:translateX(-7px) rotate(-5deg)} 75%{transform:translateX(7px) rotate(5deg)} }
@keyframes kd-cl{ 0%,100%{transform:rotate(0)} 25%{transform:rotate(28deg)} 75%{transform:rotate(-8deg)} }
@keyframes kd-cr{ 0%,100%{transform:rotate(0)} 25%{transform:rotate(-8deg)} 75%{transform:rotate(-28deg)} }
@keyframes kd-lg{ 0%,100%{transform:translateY(0)} 50%{transform:translateY(-3px)} }
.sa-e-dancing #sa-body { animation:kd-bd .65s ease-in-out infinite }
.sa-e-dancing #sa-cl   { animation:kd-cl .65s ease-in-out infinite }
.sa-e-dancing #sa-cr   { animation:kd-cr .65s ease-in-out infinite }
.sa-e-dancing #sa-ll   { animation:kd-lg .65s ease-in-out infinite }
.sa-e-dancing #sa-lr   { animation:kd-lg .65s .325s ease-in-out infinite }

/* EXCITED — fast full-body bounce + quick alternating claws */
@keyframes ke-bd{ 0%,100%{transform:translateY(0) scaleX(1)} 30%{transform:translateY(-16px) scaleX(.96)} 55%{transform:translateY(3px) scaleX(1.04)} }
@keyframes ke-cl{ 0%,100%{transform:rotate(-10deg)} 50%{transform:rotate(30deg)} }
@keyframes ke-cr{ 0%,100%{transform:rotate(10deg)} 50%{transform:rotate(-30deg)} }
.sa-e-excited #sa-body { animation:ke-bd .45s ease-in-out infinite }
.sa-e-excited #sa-cl   { animation:ke-cl .45s ease-in-out infinite }
.sa-e-excited #sa-cr   { animation:ke-cr .45s .225s ease-in-out infinite }

/* SLEEPING — slow breathe, droopy claws, zzz's */
@keyframes ksl-bd { 0%,100%{transform:translateY(0) scaleX(1)} 50%{transform:translateY(4px) scaleX(1.04)} }
@keyframes ksl-cl { 0%,100%{transform:rotate(-18deg)} 50%{transform:rotate(-24deg)} }
@keyframes ksl-cr { 0%,100%{transform:rotate(18deg)} 50%{transform:rotate(24deg)} }
.sa-e-sleeping #sa-body { animation:ksl-bd 3s ease-in-out infinite }
.sa-e-sleeping #sa-cl   { animation:ksl-cl 3s ease-in-out infinite }
.sa-e-sleeping #sa-cr   { animation:ksl-cr 3s ease-in-out infinite }

/* BORED — slow tilt and twitch */
@keyframes kb-bd{ 0%,65%,100%{transform:rotate(0) translateY(0)} 75%{transform:rotate(-5deg) translateY(3px)} 88%{transform:rotate(2deg)} }
@keyframes kb-cl{ 0%,100%{transform:rotate(-14deg)} 50%{transform:rotate(-18deg)} }
@keyframes kb-cr{ 0%,100%{transform:rotate(10deg)} 50%{transform:rotate(14deg)} }
.sa-e-bored #sa-body { animation:kb-bd 4s ease-in-out infinite }
.sa-e-bored #sa-cl   { animation:kb-cl 4s ease-in-out infinite }
.sa-e-bored #sa-cr   { animation:kb-cr 4s ease-in-out infinite }

/* GOODBYE WAVE */
@keyframes kbye-cr{ 0%,100%{transform:rotate(0)} 25%{transform:rotate(-42deg)} 55%{transform:rotate(6deg)} 75%{transform:rotate(-28deg)} }
@keyframes kbye-bd{ 0%,100%{transform:translateY(0)} 35%{transform:translateY(-8px)} }
.sa-e-bye #sa-cr   { animation:kbye-cr .7s ease-in-out 2 }
.sa-e-bye #sa-body { animation:kbye-bd .7s ease-in-out 2 }
`;

  // ── State ─────────────────────────────────────────────────────────────────
  const POPUP_EMOTIONS = ['waving','surprised','happy','excited','bored','sleeping','wow'];
  let stage, wrap, bubble, zzzEls = [], hideTimer, reappearTimer, currentMode;

  function rand(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
  function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }

  function pickMode() {
    const total = SPAWN_MODES.reduce((s,m)=>s+m.weight, 0);
    let r = Math.random() * total;
    for (const m of SPAWN_MODES) { r -= m.weight; if (r <= 0) return m; }
    return SPAWN_MODES[0];
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function build() {
    stage = document.createElement('div');
    stage.id = 'sa-stage';

    bubble = document.createElement('div');
    bubble.id = 'sa-bubble';
    stage.appendChild(bubble);

    wrap = document.createElement('div');
    wrap.id = 'sa-wrap';
    wrap.innerHTML = CRAB_SVG;
    wrap.addEventListener('click', onCrabClick);
    stage.appendChild(wrap);

    document.body.appendChild(stage);
  }

  // ── Emotion ───────────────────────────────────────────────────────────────
  function clearZzz() { zzzEls.forEach(e=>e.remove()); zzzEls=[]; }

  function setEmotion(name) {
    stage.className.split(' ').filter(c=>c.startsWith('sa-e-')).forEach(c=>stage.classList.remove(c));
    clearZzz();
    if (!name || REDUCED) return;
    stage.classList.add('sa-e-' + name);
    if (name === 'sleeping') {
      ['z','z','z'].forEach((_,i)=>{
        const z = document.createElement('span');
        z.className = 'sa-zzz'; z.textContent = 'z';
        z.style.animationDelay = (i * 0.8) + 's';
        wrap.appendChild(z); zzzEls.push(z);
      });
    }
  }

  // ── Bubble ────────────────────────────────────────────────────────────────
  function showBubble(text) { bubble.textContent = text; bubble.classList.add('sa-bon'); }
  function hideBubble()     { bubble.classList.remove('sa-bon'); }

  // ── Appear / dismiss ─────────────────────────────────────────────────────
  function appear() {
    const mode = pickMode();
    currentMode = mode;

    // Reset stage classes/styles
    stage.className = 'sa-' + (mode.type.startsWith('scuttle') ? 'scuttle ' + mode.type : mode.type === 'corner-right' ? 'right' : mode.type === 'corner-left' ? 'left' : 'center');

    // Mirror wrap for left-facing
    wrap.classList.toggle('sa-flip', mode.mirrored);

    // Emotion
    const emotion = mode.emotion || rand(POPUP_EMOTIONS);
    setEmotion(emotion);
    hideBubble();

    // Trigger entrance
    void stage.offsetWidth; // reflow
    stage.classList.add('sa-on');

    // Auto-dismiss
    clearTimeout(hideTimer);
    const duration = mode.type.startsWith('scuttle') ? 10500 : randInt(6000, 9500);
    hideTimer = setTimeout(dismiss, duration);
  }

  function dismiss() {
    clearTimeout(hideTimer);
    hideBubble();

    if (!currentMode || !currentMode.type.startsWith('scuttle')) {
      // Popup: wave goodbye then slide down
      setEmotion('bye');
      setTimeout(() => {
        stage.classList.remove('sa-on');
        stage.classList.add('sa-out');
        clearZzz();
        scheduleReappear();
      }, REDUCED ? 0 : 950);
    } else {
      // Scuttle: just let it finish and vanish
      stage.classList.remove('sa-on');
      clearZzz();
      scheduleReappear();
    }
  }

  function scheduleReappear() {
    clearTimeout(reappearTimer);
    reappearTimer = setTimeout(appear, randInt(20000, 45000));
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
