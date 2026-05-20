// Still Afloat — Crab Mascot v4
// Appears anywhere on the page: edges, center, random float, drop from top.
// Mid-screen appearances get outrageous entrances (pirouette, cannonball, etc.)
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
    "I came sideways. Fastest route.",
    "No pinching. Unless you skip dessert.",
    "I walked from Nassau. Worth it.",
    "SURPRISE! Did you miss me?",
    "Plot twist: I can swim.",
    "I majored in Cruise Studies. 🎓",
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
    "Llegué de lado — la ruta más rápida.",
    "Sin pellizcos. Salvo si saltaste el postre.",
    "¡SORPRESA! ¿Me extrañabas?",
    "Giro argumental: sé nadar.",
    "Me gradué en Estudios de Crucero. 🎓",
  ];

  // ── Inline SVG ───────────────────────────────────────────────────────────
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
  <ellipse cx="110" cy="173" rx="50" ry="7" fill="rgba(0,0,0,0.18)"/>
  <g id="sa-ll">
    <line x1="72" y1="138" x2="48" y2="158" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="64" y1="128" x2="36" y2="144" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="58" y1="117" x2="28" y2="128" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <circle cx="48" cy="158" r="4.5" fill="#a02200"/>
    <circle cx="36" cy="144" r="4.5" fill="#a02200"/>
    <circle cx="28" cy="128" r="4.5" fill="#a02200"/>
  </g>
  <g id="sa-lr">
    <line x1="148" y1="138" x2="172" y2="158" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="156" y1="128" x2="184" y2="144" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <line x1="162" y1="117" x2="192" y2="128" stroke="#bf2800" stroke-width="6" stroke-linecap="round"/>
    <circle cx="172" cy="158" r="4.5" fill="#a02200"/>
    <circle cx="184" cy="144" r="4.5" fill="#a02200"/>
    <circle cx="192" cy="128" r="4.5" fill="#a02200"/>
  </g>
  <g id="sa-cl" style="transform-box:fill-box;transform-origin:78px 104px">
    <path d="M78,104 Q52,86 36,68" stroke="#bf2800" stroke-width="15" stroke-linecap="round" fill="none"/>
    <ellipse cx="24" cy="56" rx="24" ry="14" fill="url(#cg-cl)" transform="rotate(-28,24,56)"/>
    <ellipse cx="20" cy="73" rx="18" ry="11" fill="url(#cg-cl)" transform="rotate(18,20,73)"/>
    <ellipse cx="20" cy="52" rx="9" ry="5" fill="rgba(255,170,90,0.45)" transform="rotate(-28,20,52)"/>
  </g>
  <g id="sa-cr" style="transform-box:fill-box;transform-origin:142px 104px">
    <path d="M142,104 Q168,86 184,68" stroke="#bf2800" stroke-width="15" stroke-linecap="round" fill="none"/>
    <ellipse cx="196" cy="56" rx="24" ry="14" fill="url(#cg-cl)" transform="rotate(28,196,56)"/>
    <ellipse cx="200" cy="73" rx="18" ry="11" fill="url(#cg-cl)" transform="rotate(-18,200,73)"/>
    <ellipse cx="200" cy="52" rx="9" ry="5" fill="rgba(255,170,90,0.45)" transform="rotate(28,200,52)"/>
  </g>
  <g id="sa-body" style="transform-box:fill-box;transform-origin:110px 120px">
    <ellipse cx="110" cy="120" rx="58" ry="50" fill="url(#cg-bd)"
      style="filter:drop-shadow(0 5px 10px rgba(0,0,0,0.32))"/>
    <ellipse cx="110" cy="135" rx="36" ry="28" fill="url(#cg-bl)"/>
    <ellipse cx="95" cy="103" rx="17" ry="11" fill="rgba(255,200,130,0.38)" transform="rotate(-22,95,103)"/>
  </g>
  <g id="sa-el" style="transform-box:fill-box;transform-origin:90px 100px">
    <circle cx="90" cy="100" r="17" fill="white"/>
    <circle cx="92" cy="102" r="10" fill="#111"/>
    <circle cx="97" cy="97"  r="4"  fill="white"/>
  </g>
  <g id="sa-er" style="transform-box:fill-box;transform-origin:130px 100px">
    <circle cx="130" cy="100" r="17" fill="white"/>
    <circle cx="132" cy="102" r="10" fill="#111"/>
    <circle cx="137" cy="97"  r="4"  fill="white"/>
  </g>
  <g id="sa-mouth">
    <path d="M96,120 Q110,134 124,120" stroke="#b01800" stroke-width="3.5"
      fill="rgba(200,40,30,0.82)" stroke-linecap="round"/>
    <ellipse cx="110" cy="126" rx="8" ry="5" fill="#ff6080"/>
  </g>
  <line x1="96"  y1="84" x2="82"  y2="62" stroke="#bf2800" stroke-width="3" stroke-linecap="round"/>
  <circle cx="82" cy="60" r="4.5" fill="#ff5020"/>
  <line x1="124" y1="84" x2="138" y2="62" stroke="#bf2800" stroke-width="3" stroke-linecap="round"/>
  <circle cx="138" cy="60" r="4.5" fill="#ff5020"/>
</svg>`;

  // ── CSS ──────────────────────────────────────────────────────────────────
  const CSS = `
#sa-stage {
  position: fixed;
  z-index: 99998;
  pointer-events: none;
  will-change: transform, opacity;
}

/* ── Wrap: click target, also handles whole-crab entrance animations ── */
#sa-wrap {
  cursor: pointer;
  pointer-events: all;
  position: relative;
  display: inline-block;
  line-height: 0;
  transform-origin: center bottom;
}
#sa-wrap.sa-flip { transform: scaleX(-1); }

/* ── Bubble ── */
#sa-bubble {
  position: absolute;
  bottom: 110%;
  left: 50%;
  transform: translateX(-50%) scale(0.7) translateY(8px);
  background: #fff;
  color: #07183f;
  font-family: 'Baloo 2','Segoe UI',sans-serif;
  font-size: 13px; font-weight: 700; line-height: 1.35;
  padding: 9px 14px;
  border-radius: 16px;
  border: 2.5px solid #ffca4f;
  box-shadow: 0 6px 20px rgba(0,0,0,0.22);
  max-width: 185px; text-align: center;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
  pointer-events: none;
}
#sa-bubble::after {
  content:''; position:absolute;
  bottom:-9px; left:50%; transform:translateX(-50%);
  border:5px solid transparent; border-top-color:#ffca4f;
}
#sa-bubble.sa-bon {
  opacity:1;
  transform: translateX(-50%) scale(1) translateY(0);
}

/* ── zzz ── */
.sa-zzz {
  position:absolute; top:4px; right:-4px;
  color:#5dff9a; font-weight:900; font-size:16px; line-height:1;
  opacity:0; pointer-events:none;
  animation: sa-zf 2.4s ease-in-out infinite;
}
.sa-zzz:nth-child(2){ font-size:11px; right:4px; top:17px; animation-delay:.8s; }
.sa-zzz:nth-child(3){ font-size:7px;  right:8px; top:25px; animation-delay:1.6s; }
@keyframes sa-zf{ 0%{opacity:0;transform:translate(0,0) scale(.5)} 15%{opacity:1} 85%{opacity:.5} 100%{opacity:0;transform:translate(6px,-22px) scale(1)} }

/* ── Mobile ── */
@media(max-width:600px){ #sa-svg { width:95px !important; height:auto !important; } }

/* ════════════════════════════════════════════════════════════════════════════
   WHOLE-CRAB ENTRANCE / EXIT animations (applied to #sa-wrap)
   ════════════════════════════════════════════════════════════════════════════ */

/* EDGE POPUP — slide up from below, exit slides back down */
@keyframes en-edge-in  { from{transform:translateY(130%)} to{transform:translateY(0)} }
@keyframes en-edge-out { from{transform:translateY(0)} to{transform:translateY(130%)} }
.sa-en-edge  { animation: en-edge-in  .55s cubic-bezier(0.34,1.56,0.64,1) forwards }
.sa-ex-edge  { animation: en-edge-out .38s ease-in forwards }

/* SCALE POP — materialises in thin air, pops in, exits by vanishing */
@keyframes en-pop-in  { 0%{transform:scale(0) rotate(-30deg);opacity:0} 60%{transform:scale(1.2) rotate(5deg);opacity:1} 100%{transform:scale(1) rotate(0);opacity:1} }
@keyframes en-pop-out { 0%{transform:scale(1);opacity:1} 100%{transform:scale(0) rotate(20deg);opacity:0} }
.sa-en-pop  { animation: en-pop-in  .5s cubic-bezier(0.34,1.56,0.64,1) forwards }
.sa-ex-pop  { animation: en-pop-out .35s ease-in forwards }

/* DROP IN — falls from top of viewport with a bounce */
@keyframes en-drop-in  { 0%{transform:translateY(-120%) scaleY(0.7);opacity:0} 55%{transform:translateY(6%) scaleY(1.12);opacity:1} 75%{transform:translateY(-3%) scaleY(0.96)} 90%{transform:translateY(2%)} 100%{transform:translateY(0) scaleY(1)} }
@keyframes en-drop-out { 0%{transform:translateY(0);opacity:1} 100%{transform:translateY(200%);opacity:0} }
.sa-en-drop  { animation: en-drop-in  .7s cubic-bezier(0.34,1.56,0.64,1) forwards }
.sa-ex-drop  { animation: en-drop-out .4s ease-in forwards }

/* SCUTTLE — horizontal translation (managed via inline style animation) */
@keyframes scuttle-lr { from{transform:translateX(0)} to{transform:translateX(var(--scuttle-dist))} }
@keyframes scuttle-rl { from{transform:translateX(0)} to{transform:translateX(var(--scuttle-dist))} }

/* ════════════════════════════════════════════════════════════════════════════
   EMOTION ANIMATIONS (applied to body parts via #sa-stage class)
   ════════════════════════════════════════════════════════════════════════════ */

/* WAVING */
@keyframes kw-cr{ 0%,100%{transform:rotate(0)} 30%{transform:rotate(-38deg)} 65%{transform:rotate(8deg)} 82%{transform:rotate(-22deg)} }
@keyframes kw-bd{ 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
.sa-e-waving #sa-cr  { animation:kw-cr .9s ease-in-out infinite }
.sa-e-waving #sa-body{ animation:kw-bd .9s ease-in-out infinite }

/* HAPPY — both claws up, hop */
@keyframes kh-cl{ 0%,100%{transform:rotate(0)} 50%{transform:rotate(28deg)} }
@keyframes kh-cr{ 0%,100%{transform:rotate(0)} 50%{transform:rotate(-28deg)} }
@keyframes kh-bd{ 0%,100%{transform:translateY(0) scaleY(1)} 40%{transform:translateY(-10px) scaleY(1.05)} 60%{transform:translateY(2px) scaleY(.96)} }
.sa-e-happy #sa-cl  { animation:kh-cl 1s ease-in-out infinite }
.sa-e-happy #sa-cr  { animation:kh-cr 1s ease-in-out infinite }
.sa-e-happy #sa-body{ animation:kh-bd 1s ease-in-out infinite }

/* SURPRISED */
@keyframes ks-eye{ 0%{transform:scale(1)} 20%{transform:scale(1.52)} 100%{transform:scale(1.38)} }
@keyframes ks-cl { 0%{transform:rotate(0)} 20%{transform:rotate(42deg)} 100%{transform:rotate(28deg)} }
@keyframes ks-cr { 0%{transform:rotate(0)} 20%{transform:rotate(-42deg)} 100%{transform:rotate(-28deg)} }
@keyframes ks-bd { 0%{transform:translateY(0)} 15%{transform:translateY(-14px)} 35%{transform:translateY(3px)} 100%{transform:translateY(0)} }
.sa-e-surprised #sa-el,.sa-e-wow #sa-el { animation:ks-eye .5s ease-out forwards }
.sa-e-surprised #sa-er,.sa-e-wow #sa-er { animation:ks-eye .5s ease-out forwards }
.sa-e-surprised #sa-cl,.sa-e-wow #sa-cl { animation:ks-cl .5s ease-out forwards }
.sa-e-surprised #sa-cr,.sa-e-wow #sa-cr { animation:ks-cr .5s ease-out forwards }
.sa-e-surprised #sa-body,.sa-e-wow #sa-body { animation:ks-bd .5s ease-out forwards }

/* DANCING */
@keyframes kd-bd{ 0%,100%{transform:translateX(0) rotate(0)} 25%{transform:translateX(-7px) rotate(-5deg)} 75%{transform:translateX(7px) rotate(5deg)} }
@keyframes kd-cl{ 0%,100%{transform:rotate(0)} 25%{transform:rotate(28deg)} 75%{transform:rotate(-8deg)} }
@keyframes kd-cr{ 0%,100%{transform:rotate(0)} 25%{transform:rotate(-8deg)} 75%{transform:rotate(-28deg)} }
@keyframes kd-lg{ 0%,100%{transform:translateY(0)} 50%{transform:translateY(-3px)} }
.sa-e-dancing #sa-body { animation:kd-bd .65s ease-in-out infinite }
.sa-e-dancing #sa-cl   { animation:kd-cl .65s ease-in-out infinite }
.sa-e-dancing #sa-cr   { animation:kd-cr .65s ease-in-out infinite }
.sa-e-dancing #sa-ll   { animation:kd-lg .65s ease-in-out infinite }
.sa-e-dancing #sa-lr   { animation:kd-lg .65s .325s ease-in-out infinite }

/* EXCITED — fast full-body bounce */
@keyframes ke-bd{ 0%,100%{transform:translateY(0) scaleX(1)} 30%{transform:translateY(-18px) scaleX(.95)} 55%{transform:translateY(3px) scaleX(1.05)} }
@keyframes ke-cl{ 0%,100%{transform:rotate(-10deg)} 50%{transform:rotate(32deg)} }
@keyframes ke-cr{ 0%,100%{transform:rotate(10deg)} 50%{transform:rotate(-32deg)} }
.sa-e-excited #sa-body { animation:ke-bd .4s ease-in-out infinite }
.sa-e-excited #sa-cl   { animation:ke-cl .4s ease-in-out infinite }
.sa-e-excited #sa-cr   { animation:ke-cr .4s .2s ease-in-out infinite }

/* SLEEPING */
@keyframes ksl-bd { 0%,100%{transform:translateY(0) scaleX(1)} 50%{transform:translateY(4px) scaleX(1.04)} }
@keyframes ksl-cl { 0%,100%{transform:rotate(-18deg)} 50%{transform:rotate(-24deg)} }
@keyframes ksl-cr { 0%,100%{transform:rotate(18deg)} 50%{transform:rotate(24deg)} }
.sa-e-sleeping #sa-body { animation:ksl-bd 3s ease-in-out infinite }
.sa-e-sleeping #sa-cl   { animation:ksl-cl 3s ease-in-out infinite }
.sa-e-sleeping #sa-cr   { animation:ksl-cr 3s ease-in-out infinite }

/* BORED */
@keyframes kb-bd{ 0%,65%,100%{transform:rotate(0) translateY(0)} 75%{transform:rotate(-5deg) translateY(3px)} 88%{transform:rotate(2deg)} }
@keyframes kb-cl{ 0%,100%{transform:rotate(-14deg)} 50%{transform:rotate(-18deg)} }
@keyframes kb-cr{ 0%,100%{transform:rotate(10deg)} 50%{transform:rotate(14deg)} }
.sa-e-bored #sa-body { animation:kb-bd 4s ease-in-out infinite }
.sa-e-bored #sa-cl   { animation:kb-cl 4s ease-in-out infinite }
.sa-e-bored #sa-cr   { animation:kb-cr 4s ease-in-out infinite }

/* PIROUETTE — full 360° spin on the whole wrap, claws flair out */
@keyframes kp-spin { 0%{transform:rotate(0) scale(1)} 25%{transform:rotate(180deg) scale(1.4)} 55%{transform:rotate(360deg) scale(0.85)} 70%{transform:rotate(400deg) scale(1.2)} 85%{transform:rotate(355deg) scale(1.05)} 100%{transform:rotate(360deg) scale(1)} }
@keyframes kp-cl { 0%,100%{transform:rotate(0)} 30%{transform:rotate(55deg)} 60%{transform:rotate(-10deg)} }
@keyframes kp-cr { 0%,100%{transform:rotate(0)} 30%{transform:rotate(-55deg)} 60%{transform:rotate(10deg)} }
@keyframes kp-el { 0%,100%{transform:scale(1)} 25%{transform:scale(1.4)} 55%{transform:scale(.85)} 80%{transform:scale(1.15)} }
.sa-e-pirouette #sa-wrap { animation:kp-spin 1.4s cubic-bezier(0.34,1.56,0.64,1) infinite }
.sa-e-pirouette #sa-cl   { animation:kp-cl 1.4s ease-in-out infinite }
.sa-e-pirouette #sa-cr   { animation:kp-cr 1.4s ease-in-out infinite }
.sa-e-pirouette #sa-el   { animation:kp-el 1.4s ease-in-out infinite }
.sa-e-pirouette #sa-er   { animation:kp-el 1.4s .7s ease-in-out infinite }

/* CANNONBALL — squish down, LAUNCH upward, squish on landing */
@keyframes kcb-bd { 0%{transform:scaleY(0.7) scaleX(1.2) translateY(6px)} 20%{transform:scaleY(1.25) scaleX(.85) translateY(-22px)} 45%{transform:scaleY(0.75) scaleX(1.18) translateY(8px)} 62%{transform:scaleY(1.12) scaleX(.9) translateY(-8px)} 78%{transform:scaleY(.92) scaleX(1.05) translateY(2px)} 100%{transform:scaleY(1) scaleX(1) translateY(0)} }
@keyframes kcb-cl { 0%,100%{transform:rotate(0)} 25%{transform:rotate(55deg)} 55%{transform:rotate(-15deg)} }
@keyframes kcb-cr { 0%,100%{transform:rotate(0)} 25%{transform:rotate(-55deg)} 55%{transform:rotate(15deg)} }
.sa-e-cannonball #sa-body { animation:kcb-bd .8s ease-out infinite }
.sa-e-cannonball #sa-cl   { animation:kcb-cl .8s ease-out infinite }
.sa-e-cannonball #sa-cr   { animation:kcb-cr .8s ease-out infinite }

/* GOODBYE WAVE */
@keyframes kbye-cr{ 0%,100%{transform:rotate(0)} 25%{transform:rotate(-42deg)} 55%{transform:rotate(6deg)} 75%{transform:rotate(-28deg)} }
@keyframes kbye-bd{ 0%,100%{transform:translateY(0)} 35%{transform:translateY(-8px)} }
.sa-e-bye #sa-cr   { animation:kbye-cr .7s ease-in-out 2 }
.sa-e-bye #sa-body { animation:kbye-bd .7s ease-in-out 2 }
`;

  // ── Spawn definitions ────────────────────────────────────────────────────
  // type: 'edge'|'float'|'scuttle'
  // positionFn: returns {top,left,right,bottom,transform} as inline style strings
  // entrance/exitClass: CSS class controlling wrap animation
  // emotion: null = pick random, otherwise fixed
  // weight: relative probability
  const SPAWNS = [
    {
      id: 'edge-right', weight: 22, type: 'edge',
      pos: () => ({ bottom:'0', right:'20px' }),
      enterClass:'sa-en-edge', exitClass:'sa-ex-edge',
      emotion: null, mirrored: false,
    },
    {
      id: 'edge-left', weight: 18, type: 'edge',
      pos: () => ({ bottom:'0', left:'20px' }),
      enterClass:'sa-en-edge', exitClass:'sa-ex-edge',
      emotion: null, mirrored: true,
    },
    {
      id: 'center', weight: 14, type: 'float',
      pos: () => ({ top:'50%', left:'50%', transform:'translate(-50%,-50%)' }),
      enterClass:'sa-en-pop', exitClass:'sa-ex-pop',
      emotion: 'pirouette', mirrored: false,
    },
    {
      id: 'random', weight: 14, type: 'float',
      pos: () => {
        const x = randInt(10, 75);
        const y = randInt(18, 68);
        return { top: y+'vh', left: x+'vw' };
      },
      enterClass:'sa-en-pop', exitClass:'sa-ex-pop',
      emotion: null, mirrored: false,
    },
    {
      id: 'drop-top', weight: 12, type: 'float',
      pos: () => ({ top:'15%', left: randInt(20,70)+'vw' }),
      enterClass:'sa-en-drop', exitClass:'sa-ex-drop',
      emotion: 'cannonball', mirrored: false,
    },
    {
      id: 'scuttle-lr', weight: 10, type: 'scuttle',
      pos: () => ({ bottom:'8px', left:'0' }),
      emotion: 'dancing', mirrored: false,
    },
    {
      id: 'scuttle-rl', weight: 10, type: 'scuttle',
      pos: () => ({ bottom:'8px', right:'0' }),
      emotion: 'dancing', mirrored: true,
    },
  ];

  const POPUP_EMOTIONS = ['waving','surprised','happy','excited','bored','sleeping','wow','pirouette','cannonball'];

  function rand(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
  function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }

  let stage, wrap, bubble, zzzEls = [], hideTimer, reappearTimer, activeSpawn;

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function build() {
    stage = document.createElement('div');
    stage.id = 'sa-stage';

    wrap = document.createElement('div');
    wrap.id = 'sa-wrap';
    wrap.innerHTML = CRAB_SVG;

    bubble = document.createElement('div');
    bubble.id = 'sa-bubble';
    wrap.appendChild(bubble);

    wrap.addEventListener('click', onCrabClick);
    stage.appendChild(wrap);
    document.body.appendChild(stage);
  }

  function pickSpawn() {
    const total = SPAWNS.reduce((s,m) => s+m.weight, 0);
    let r = Math.random() * total;
    for (const m of SPAWNS) { r -= m.weight; if (r <= 0) return m; }
    return SPAWNS[0];
  }

  // ── Emotion helpers ───────────────────────────────────────────────────────
  function clearZzz() { zzzEls.forEach(e=>e.remove()); zzzEls=[]; }

  function setEmotion(name) {
    // Clear old emotion classes from stage
    Array.from(stage.classList).filter(c=>c.startsWith('sa-e-')).forEach(c=>stage.classList.remove(c));
    clearZzz();
    if (!name || REDUCED) return;
    stage.classList.add('sa-e-' + name);
    if (name === 'sleeping') {
      ['z','z','z'].forEach((_,i) => {
        const z = document.createElement('span');
        z.className = 'sa-zzz'; z.textContent='z';
        z.style.animationDelay = (i*0.8)+'s';
        wrap.appendChild(z); zzzEls.push(z);
      });
    }
  }

  function showBubble(text) { bubble.textContent = text; bubble.classList.add('sa-bon'); }
  function hideBubble()     { bubble.classList.remove('sa-bon'); }

  // ── Apply position ────────────────────────────────────────────────────────
  function applyPos(pos) {
    stage.style.top = pos.top || '';
    stage.style.bottom = pos.bottom || '';
    stage.style.left = pos.left || '';
    stage.style.right = pos.right || '';
    if (pos.transform) stage.style.transform = pos.transform;
    else stage.style.transform = '';
  }

  // ── Appear / dismiss ─────────────────────────────────────────────────────
  function appear() {
    const spawn = pickSpawn();
    activeSpawn = spawn;

    // Reset
    stage.removeAttribute('style');
    wrap.className = 'sa-wrap';
    Array.from(stage.classList).filter(c=>c.startsWith('sa-e-')).forEach(c=>stage.classList.remove(c));
    hideBubble(); clearZzz();

    // Position
    applyPos(spawn.pos());

    // Mirror for left-facing
    if (spawn.mirrored) wrap.classList.add('sa-flip');

    // Emotion
    const emotion = spawn.emotion || rand(POPUP_EMOTIONS);
    setEmotion(emotion);

    // Scuttle: animate across the screen
    // When reduced-motion is on, skip scuttle entirely — re-pick a non-scuttle spawn.
    if (spawn.type === 'scuttle') {
      if (REDUCED) {
        // Fall back to a simple edge pop so something still appears
        activeSpawn = SPAWNS.find(s => s.id === 'edge-right');
        applyPos(activeSpawn.pos());
        wrap.classList.remove('sa-flip');
        setEmotion(rand(['waving', 'happy', 'bored']));
        hideTimer = setTimeout(dismiss, randInt(5000, 8000));
        return;
      }
      const duration = 10000;
      const startX = spawn.id === 'scuttle-lr' ? -(window.innerWidth * 0.15 + 200) : (window.innerWidth + 200);
      const endX   = spawn.id === 'scuttle-lr' ? (window.innerWidth + 200) : -(window.innerWidth * 0.15 + 200);
      stage.style.left = startX + 'px';
      stage.style.right = '';
      stage.style.bottom = '8px';
      void stage.offsetWidth;
      let scuttleFrame;
      const startTime = performance.now();
      function tick(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        stage.style.left = (startX + (endX - startX) * progress) + 'px';
        if (progress < 1) { scuttleFrame = requestAnimationFrame(tick); }
        else { scuttleFrame = null; dismiss(); }
      }
      scuttleFrame = requestAnimationFrame(tick);
      // Store cancellation handle on stage so dismiss() can stop it
      stage._scuttleFrame = () => { if (scuttleFrame) cancelAnimationFrame(scuttleFrame); scuttleFrame = null; };
      return;
    }

    // Entrance animation on wrap
    if (!REDUCED && spawn.enterClass) {
      wrap.classList.add(spawn.enterClass);
      wrap.addEventListener('animationend', () => wrap.classList.remove(spawn.enterClass), { once: true });
    }

    // Auto-dismiss
    clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, randInt(6000, 9500));
  }

  function dismiss() {
    clearTimeout(hideTimer);
    hideBubble();

    // Cancel any in-progress scuttle rAF
    if (stage._scuttleFrame) { stage._scuttleFrame(); delete stage._scuttleFrame; }

    if (!activeSpawn || activeSpawn.type === 'scuttle') {
      clearZzz(); scheduleReappear(); return;
    }

    const spawn = activeSpawn;

    if (REDUCED) {
      // Reduced-motion: instant vanish, no animation
      clearZzz();
      stage.style.opacity = '0';
      setTimeout(() => { stage.style.opacity = ''; scheduleReappear(); }, 50);
      return;
    }

    // All non-scuttle spawns: goodbye wave first, then exit animation
    setEmotion('bye');
    const byeDuration = spawn.type === 'edge' ? 1100 : 700; // floats get shorter wave
    setTimeout(() => {
      setEmotion(null);
      if (spawn.exitClass) {
        wrap.classList.add(spawn.exitClass);
        wrap.addEventListener('animationend', () => {
          wrap.classList.remove(spawn.exitClass);
          clearZzz();
          scheduleReappear();
        }, { once: true });
      } else {
        clearZzz();
        scheduleReappear();
      }
    }, byeDuration);
  }

  function scheduleReappear() {
    clearTimeout(reappearTimer);
    reappearTimer = setTimeout(appear, randInt(18000, 40000));
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
    reappearTimer = setTimeout(appear, randInt(3000, 8000));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
