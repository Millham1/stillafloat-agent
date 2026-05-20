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
.items-grid{display:flex;flex-direction:column;gap:28px}
.item-card{display:flex;flex-direction:row;border-radius:22px;overflow:hidden;background:rgba(7,20,43,.75);border:1px solid rgba(255,255,255,.13);backdrop-filter:blur(14px);box-shadow:0 14px 40px rgba(0,0,0,.36)}
.item-img-wrap{flex:0 0 200px;background:#0a1628;display:flex;align-items:center;justify-content:center;min-height:180px}
.item-img{width:180px;height:180px;object-fit:contain;display:block;padding:12px}
.item-body{flex:1;padding:24px 28px;display:flex;flex-direction:column;justify-content:center;gap:8px}
.item-title{font-family:'Baloo 2',sans-serif;font-size:1.3rem;font-weight:800;color:#fff}
.item-desc{font-size:.97rem;line-height:1.65;color:rgba(220,240,255,.85)}
.buy-btn{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;background:#ffca4f;color:#07183f;font-family:'Baloo 2',sans-serif;font-size:.92rem;font-weight:800;border-radius:12px;text-decoration:none;transition:background .15s,transform .1s;width:fit-content;margin-top:6px;white-space:nowrap}
.buy-btn:hover{background:#ffd76b;transform:translateY(-1px)}
.buy-btn i{font-size:.82rem}
.strip-wrap{display:contents}
.empty-state{text-align:center;padding:80px 20px;color:rgba(255,255,255,.50)}
.empty-state i{font-size:48px;margin-bottom:18px;display:block;color:rgba(93,255,154,.30)}
.empty-state h2{font-size:1.4rem;margin-bottom:10px;color:rgba(255,255,255,.70)}
.empty-state p{font-size:.95rem}
.loading{text-align:center;padding:60px 20px;color:rgba(255,255,255,.50);font-size:.95rem}
@media(max-width:680px){
  .item-card{flex-direction:column}
  .item-img-wrap{flex:none;width:100%;min-height:140px;padding:8px 0}
  .item-img{width:130px;height:130px}
  .item-body{padding:16px 18px}
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
        if (item.smartStrip) {
          const sw = document.getElementById(stripId);
          if (sw) renderStrip(sw, item.smartStrip);
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
