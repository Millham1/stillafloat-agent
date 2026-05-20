// Still Afloat — Crab Mascot
// Self-contained. Peeks from bottom-right, cycles through emotional states,
// reacts to clicks with a speech bubble. Respects prefers-reduced-motion.
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
    "Sand between my toes… and claws.",
    "Catch me on the Lido deck!",
    "Claw enforcement: cruise edition.",
    "Have you tried the buffet? Asking for a friend. 🦞"
  ];

  const LINES_ES = [
    "¡Te encontré una oferta! 🦀",
    "¡Seguimos a flote… por poco!",
    "Crucerar es mi cardio.",
    "¡No seas tan cangrejo — vete a crucerar!",
    "¡Pasan barcos. ¡Mantente a flote!",
    "Tengo el OJO puesto en ese horizonte.",
    "¡Arena entre los dedos… y las pinzas!",
    "¡Nos vemos en la cubierta Lido!",
    "Ley de la pinza: edición crucero.",
    "¿Probaste el bufé? Pregunto por un amigo. 🦞"
  ];

  const EMOTIONS = ['waving', 'surprised', 'dancing', 'sleeping', 'bored'];

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
  transform: translateY(100%);
  transition: transform 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
}
#sa-crab-stage.sa-crab-visible {
  transform: translateY(12px);
}
#sa-crab-stage.sa-crab-exit {
  transform: translateY(100%);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.6, 1);
}

#sa-crab-img {
  width: 110px;
  height: auto;
  cursor: pointer;
  pointer-events: all;
  filter: drop-shadow(0 4px 12px rgba(0,0,0,0.35));
  transform-origin: bottom center;
}

@media (max-width: 600px) {
  #sa-crab-stage { right: 12px; }
  #sa-crab-img { width: 80px; }
}

/* ── Bubble ── */
#sa-crab-bubble {
  background: #fff;
  color: #07183f;
  font-family: 'Baloo 2', 'Segoe UI', sans-serif;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  padding: 8px 12px;
  border-radius: 14px;
  border: 2px solid #ffca4f;
  box-shadow: 0 4px 16px rgba(0,0,0,0.18);
  max-width: 200px;
  text-align: center;
  margin-bottom: 8px;
  opacity: 0;
  transform: scale(0.7) translateY(6px);
  transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  pointer-events: none;
}
#sa-crab-bubble.sa-bubble-visible {
  opacity: 1;
  transform: scale(1) translateY(0);
}
#sa-crab-bubble::after {
  content: '';
  position: absolute;
  bottom: -10px;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: #ffca4f;
}

/* ── Emotion animations ── */
@keyframes sa-wave {
  0%,100% { transform: rotate(-8deg) translateY(0); }
  25%      { transform: rotate(8deg) translateY(-6px); }
  50%      { transform: rotate(-5deg) translateY(-2px); }
  75%      { transform: rotate(6deg) translateY(-8px); }
}
@keyframes sa-surprised {
  0%      { transform: scale(1); }
  15%     { transform: scale(1.25) translateY(-10px); }
  30%     { transform: scale(0.9) translateY(2px); }
  45%     { transform: scale(1.1) translateY(-4px); }
  60%,100%{ transform: scale(1) translateY(0); }
}
@keyframes sa-dance {
  0%,100% { transform: translateX(0) rotate(0deg) scaleY(1); }
  20%     { transform: translateX(-10px) rotate(-6deg) scaleY(0.95); }
  40%     { transform: translateX(0) rotate(0deg) scaleY(1.05); }
  60%     { transform: translateX(10px) rotate(6deg) scaleY(0.95); }
  80%     { transform: translateX(0) rotate(0deg) scaleY(1.05); }
}
@keyframes sa-sleep {
  0%,100% { transform: translateY(0) rotate(-3deg); }
  50%     { transform: translateY(5px) rotate(3deg); }
}
@keyframes sa-bored {
  0%,80%,100% { transform: rotate(0deg) translateY(0); }
  90%         { transform: rotate(-4deg) translateY(3px); }
}
@keyframes sa-zzzFloat {
  0%   { opacity: 0; transform: translate(0, 0) scale(0.6); }
  20%  { opacity: 1; }
  80%  { opacity: 0.6; }
  100% { opacity: 0; transform: translate(8px, -28px) scale(1); }
}

.sa-emotion-waving    { animation: sa-wave 1.0s ease-in-out infinite; }
.sa-emotion-surprised { animation: sa-surprised 0.7s ease-out forwards; }
.sa-emotion-dancing   { animation: sa-dance 0.75s ease-in-out infinite; }
.sa-emotion-sleeping  { animation: sa-sleep 2.5s ease-in-out infinite; }
.sa-emotion-bored     { animation: sa-bored 4s ease-in-out infinite; }

/* zzz */
.sa-zzz {
  position: absolute;
  top: 2px;
  right: -4px;
  font-size: 14px;
  color: #5dff9a;
  font-weight: 900;
  line-height: 1;
  opacity: 0;
  animation: sa-zzzFloat 2s ease-in-out infinite;
  pointer-events: none;
}
.sa-zzz:nth-child(2) { font-size: 10px; animation-delay: 0.7s; right: 2px; top: 10px; }
.sa-zzz:nth-child(3) { font-size: 7px;  animation-delay: 1.4s; right: 6px; top: 16px; }
`;

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  let stage, img, bubble, zzzEls = [];
  let hideTimer = null, reappearTimer = null;
  let currentEmotion = null;

  function build() {
    stage = document.createElement('div');
    stage.id = 'sa-crab-stage';

    bubble = document.createElement('div');
    bubble.id = 'sa-crab-bubble';
    stage.appendChild(bubble);

    const imgWrap = document.createElement('div');
    imgWrap.style.cssText = 'position:relative;display:inline-block;';

    img = document.createElement('img');
    img.id = 'sa-crab-img';
    img.src = '/assets/images/crab-mascot.png';
    img.alt = 'Crab mascot';
    img.draggable = false;
    img.addEventListener('click', onCrabClick);

    imgWrap.appendChild(img);
    stage.appendChild(imgWrap);
    document.body.appendChild(stage);
  }

  function clearZzz() {
    zzzEls.forEach(el => el.remove());
    zzzEls = [];
  }

  function setEmotion(emotion) {
    if (REDUCED) return;
    img.className = '';
    clearZzz();
    currentEmotion = emotion;
    img.classList.add('sa-emotion-' + emotion);

    if (emotion === 'sleeping') {
      const wrap = img.parentElement;
      ['z','z','z'].forEach((_, i) => {
        const z = document.createElement('span');
        z.className = 'sa-zzz';
        z.textContent = i === 0 ? 'z' : i === 1 ? 'z' : 'z';
        z.style.animationDelay = (i * 0.7) + 's';
        wrap.appendChild(z);
        zzzEls.push(z);
      });
    }
  }

  function showBubble(text) {
    bubble.textContent = text;
    bubble.classList.add('sa-bubble-visible');
  }

  function hideBubble() {
    bubble.classList.remove('sa-bubble-visible');
  }

  function appear() {
    if (!stage) build();
    const emotion = randomFrom(EMOTIONS);
    setEmotion(emotion);
    hideBubble();
    stage.classList.remove('sa-crab-exit');
    // force reflow
    void stage.offsetHeight;
    stage.classList.add('sa-crab-visible');

    const visibleDuration = randomInt(6000, 9000);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, visibleDuration);
  }

  function dismiss() {
    clearTimeout(hideTimer);
    hideBubble();
    // wave goodbye
    if (!REDUCED) {
      img.className = '';
      img.classList.add('sa-emotion-waving');
    }
    setTimeout(() => {
      stage.classList.remove('sa-crab-visible');
      stage.classList.add('sa-crab-exit');
      clearZzz();
      scheduleReappear();
    }, REDUCED ? 0 : 800);
  }

  function scheduleReappear() {
    clearTimeout(reappearTimer);
    const delay = randomInt(25000, 50000);
    reappearTimer = setTimeout(appear, delay);
  }

  function onCrabClick(e) {
    e.stopPropagation();
    clearTimeout(hideTimer);

    setEmotion('surprised');

    const lines = IS_SPANISH ? LINES_ES : LINES_EN;
    showBubble(randomFrom(lines));

    hideTimer = setTimeout(dismiss, 3500);
  }

  function init() {
    injectStyles();
    build();
    const firstDelay = randomInt(4000, 10000);
    reappearTimer = setTimeout(appear, firstDelay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
