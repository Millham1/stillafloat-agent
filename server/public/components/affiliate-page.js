// Still Afloat — Shared Affiliate Page Logic
// Set window.SAF_AFFILIATE_CONFIG before loading this script.
// Config: { category, emptyIcon, emptyMsg }
(function () {
  const cfg = window.SAF_AFFILIATE_CONFIG || {};
  const CATEGORY   = cfg.category   || '';
  const EMPTY_ICON = cfg.emptyIcon  || 'fa-box-open';
  const EMPTY_MSG  = cfg.emptyMsg   || 'Picks for this category are being curated — check back soon.';

  // Inject card + buy-button styles
  const style = document.createElement('style');
  style.textContent = `
/* ── Column grid ── */
.items-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px}

/* ── Portrait card ── */
.item-card{display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:rgba(7,20,43,.80);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(12px);box-shadow:0 8px 24px rgba(0,0,0,.34);transition:transform .15s,box-shadow .15s}
.item-card:hover{transform:translateY(-3px);box-shadow:0 14px 32px rgba(0,0,0,.46)}
.item-img-wrap{width:100%;aspect-ratio:1/1;background:#0b1830;display:flex;align-items:center;justify-content:center}
.item-img{width:75%;height:75%;object-fit:contain;display:block}
.item-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
.item-title{font-family:'Baloo 2',sans-serif;font-size:1rem;font-weight:800;color:#fff;line-height:1.3}
.item-desc{font-size:.82rem;line-height:1.55;color:rgba(200,225,255,.78);flex:1}
.buy-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:#ffca4f;color:#07183f;font-family:'Baloo 2',sans-serif;font-size:.82rem;font-weight:800;border-radius:10px;text-decoration:none;transition:background .15s,transform .1s;width:fit-content;margin-top:4px;white-space:nowrap}
.buy-btn:hover{background:#ffd76b;transform:translateY(-1px)}
.buy-btn i{font-size:.74rem}
.strip-wrap{display:contents}
.empty-state{text-align:center;padding:80px 20px;color:rgba(255,255,255,.50);grid-column:1/-1}
.empty-state i{font-size:48px;margin-bottom:18px;display:block;color:rgba(93,255,154,.30)}
.empty-state h2{font-size:1.4rem;margin-bottom:10px;color:rgba(255,255,255,.70)}
.empty-state p{font-size:.95rem}
.loading{text-align:center;padding:60px 20px;color:rgba(255,255,255,.50);font-size:.95rem;grid-column:1/-1}
@media(max-width:500px){
  .items-grid{grid-template-columns:repeat(2,1fr);gap:12px}
  .item-body{padding:10px 11px 12px}
}`;
  document.head.appendChild(style);

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s || '');
    return d.innerHTML;
  }

  // Upgrade small Amazon thumbnail URLs to 500px versions
  function upgradeAmazonImg(url) {
    if (!url) return url;
    // Replace size codes like _AC_AA152_, _AC_UL320_, _AC_SL200_, etc.
    return url.replace(/\._[A-Z]{2}_[A-Z0-9,_]+_\./g, '._AC_SL500_.');
  }

  // smartStrip: plain URL → Buy button. HTML string → inject as widget.
  function renderStrip(wrap, val) {
    if (!val || !val.trim()) return;
    if (/^https?:\/\//i.test(val.trim())) {
      const btn = document.createElement('a');
      btn.href = val.trim();
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer sponsored';
      btn.className = 'buy-btn';
      btn.innerHTML = 'Buy on Amazon <i class="fa-solid fa-arrow-up-right-from-square"></i>';
      wrap.appendChild(btn);
      return;
    }
    // HTML widget (e.g. Amazon Native Shopping Ad embed)
    const tmp = document.createElement('div');
    tmp.innerHTML = val;
    Array.from(tmp.childNodes).forEach(n => {
      if (n.nodeName !== 'SCRIPT') wrap.appendChild(n.cloneNode(true));
    });
    tmp.querySelectorAll('script').forEach(old => {
      const s = document.createElement('script');
      Array.from(old.attributes).forEach(a => s.setAttribute(a.name, a.value));
      if (!old.src) s.textContent = old.textContent;
      wrap.appendChild(s);
    });
  }

  async function loadItems() {
    const container = document.getElementById('items-container');
    if (!container) return;
    try {
      const resp = await fetch('/api/affiliate-items?category=' + encodeURIComponent(CATEGORY));
      const data = await resp.json();
      if (!data.items || data.items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <i class="fa-solid ${esc(EMPTY_ICON)}"></i>
            <h2>Coming soon</h2>
            <p>${esc(EMPTY_MSG)}</p>
          </div>`;
        return;
      }
      container.innerHTML = '';
      data.items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'item-card';
        const imgHtml = item.imageUrl
          ? `<div class="item-img-wrap">
               <img class="item-img"
                 src="${esc(upgradeAmazonImg(item.imageUrl))}"
                 alt="${esc(item.title)}"
                 loading="lazy"
                 onerror="this.parentElement.style.display='none'">
             </div>`
          : '';
        const stripId = 'strip-' + item.id.replace(/[^a-z0-9]/gi, '');
        card.innerHTML = `
          ${imgHtml}
          <div class="item-body">
            <div class="item-title">${esc(item.title)}</div>
            ${item.description ? `<p class="item-desc">${esc(item.description)}</p>` : ''}
            <div class="strip-wrap" id="${stripId}"></div>
          </div>`;
        container.appendChild(card);
        // smartStrip (pasted HTML ad widget) wins if present; affiliateLink (plain
        // tagged URL, what the dashboard's "Affiliate Link URL" field actually saves)
        // is the fallback. Without this fallback, any item added with only that field
        // filled in — the normal case — silently rendered with no buy button at all
        // (observed 2026-08-11: 4 new clothing items had real affiliateLink values but
        // smartStrip:"", so renderStrip() never ran).
        const stripValue = item.smartStrip || item.affiliateLink;
        if (stripValue) {
          const sw = document.getElementById(stripId);
          if (sw) renderStrip(sw, stripValue);
        }
      });
    } catch (err) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-circle-exclamation"></i>
          <h2>Could not load</h2>
          <p>Please try again in a moment.</p>
        </div>`;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadItems);
  } else {
    loadItems();
  }
})();
