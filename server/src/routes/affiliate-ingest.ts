import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken, extractToken } from "../lib/http-auth";
import { ingestProducts, loadPending, approvePending, rejectPending, type RawProduct } from "../lib/affiliate-agent";
import { notifyMark, reviewUrl } from "../lib/notify";

const router: IRouter = Router();

// POST /api/affiliate/ingest — raw products from the "Still Afloat Gear" wishlist
// (read via Chrome). Body: { items: [{ asin, title, imageUrl? }] }
router.post("/affiliate/ingest", requireToken, async (req: Request, res: Response) => {
  try {
    const items = (req.body as { items?: RawProduct[] })?.items;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, error: "items[] required" });
      return;
    }
    const { added, skipped } = await ingestProducts(items);
    let notified = false;
    if (added.length > 0) {
      // Awaited (not fire-and-forget) so the review nudge reliably sends.
      const channel = await notifyMark({
        title: `🛒 ${added.length} new affiliate pick(s) for review`,
        body: added.slice(0, 10).map((a) => `${a.category}: ${a.title.slice(0, 70)}`).join("\n"),
        url: reviewUrl("/api/affiliate/review"),
        tag: "affiliate-review",
      }).catch(() => "none" as const);
      notified = channel !== "none";
    }
    res.json({ success: true, added: added.length, skipped, notified });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/affiliate/notify — re-send the review nudge for the current queue (manual).
router.post("/affiliate/notify", requireToken, async (_req: Request, res: Response) => {
  const pending = await loadPending();
  const n = pending.items.length;
  const channel = await notifyMark({
    title: `🛒 ${n} affiliate pick(s) awaiting review`,
    body: pending.items.slice(0, 10).map((i) => `${i.category}: ${i.title.slice(0, 70)}`).join("\n"),
    url: reviewUrl("/api/affiliate/review"),
    tag: "affiliate-review",
  });
  res.json({ success: channel !== "none", pending: n, channel });
});

// GET /api/affiliate/pending — queued picks awaiting review.
router.get("/affiliate/pending", requireToken, async (_req: Request, res: Response) => {
  const pending = await loadPending();
  res.json({ success: true, count: pending.items.length, items: pending.items });
});

// POST /api/affiliate/pending/:id/:action — approve | feature | reject.
router.post("/affiliate/pending/:id/:action", requireToken, async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] ?? "";
    const action = req.params["action"];
    if (action === "reject") {
      const ok = await rejectPending(id);
      res.status(ok ? 200 : 404).json({ success: ok });
      return;
    }
    if (action === "approve" || action === "feature") {
      const published = await approvePending(id, action === "feature");
      if (!published) {
        res.status(404).json({ success: false, error: "not found or link missing required tag" });
        return;
      }
      res.json({ success: true, id: published.id, featured: published.featured });
      return;
    }
    res.status(400).json({ success: false, error: "action must be approve, feature or reject" });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// GET /api/affiliate/review?token=… — token-gated review page (Approve/Feature/Reject).
router.get("/affiliate/review", requireToken, async (req: Request, res: Response) => {
  const token = extractToken(req);
  const pending = await loadPending();
  const cards = pending.items
    .map(
      (it) => `
    <div class="card" id="c-${esc(it.id)}">
      ${it.imageUrl ? `<img src="${esc(it.imageUrl)}" alt="" onerror="this.style.display='none'"/>` : ""}
      <div class="body">
        <span class="cat">${esc(it.category)}</span>
        <div class="title">${esc(it.title)}</div>
        <p class="desc">${esc(it.description)}</p>
        <a class="link" href="${esc(it.affiliateLink)}" target="_blank" rel="noopener">${esc(it.affiliateLink)}</a>
        <div class="acts">
          <button class="ap" onclick="act('${esc(it.id)}','approve')">✅ Approve</button>
          <button class="ft" onclick="act('${esc(it.id)}','feature')">⭐ Feature</button>
          <button class="rj" onclick="act('${esc(it.id)}','reject')">✕ Reject</button>
        </div>
      </div>
    </div>`,
    )
    .join("");

  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Gear Review</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#07183f;color:#eaf2ff}
 header{background:#0b2350;padding:14px 18px;position:sticky;top:0}header h1{margin:0;font-size:17px;color:#5dff9a}
 .wrap{max-width:720px;margin:0 auto;padding:16px 14px 60px}
 .card{display:flex;gap:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px;margin-bottom:14px}
 .card img{width:96px;height:96px;object-fit:contain;background:#0b1830;border-radius:10px;flex:none}
 .body{flex:1;min-width:0}
 .cat{display:inline-block;font-size:11px;font-weight:700;background:#13325f;border:1px solid #2b5599;color:#9cc3ff;border-radius:5px;padding:2px 8px;margin-bottom:6px}
 .title{font-weight:800;font-size:15px;line-height:1.3;margin-bottom:4px}
 .desc{font-size:13px;color:#bcd3f5;line-height:1.5;margin:0 0 6px}
 .link{font-size:11px;color:#7fb0ff;word-break:break-all;text-decoration:none}
 .acts{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
 .acts button{border:0;border-radius:8px;padding:8px 12px;font-weight:700;color:#07183f;cursor:pointer}
 .ap{background:#5dff9a}.ft{background:#ffca4f}.rj{background:#ff8a8a}
 .empty{text-align:center;color:#7f9bcb;padding:50px 0}
</style></head><body>
<header><h1>Still Afloat — Gear Review</h1></header>
<div class="wrap">${cards || '<div class="empty">No picks awaiting review. 🛟</div>'}</div>
<script>
 var TOKEN=${JSON.stringify(token)};
 function act(id,a){
   fetch('/api/affiliate/pending/'+id+'/'+a,{method:'POST',headers:{'x-affiliate-token':TOKEN}})
    .then(function(r){return r.json();}).then(function(j){
      var el=document.getElementById('c-'+id);
      if(j.success&&el){el.style.opacity=.45;el.querySelector('.acts').innerHTML=(a==='reject'?'✕ Rejected':a==='feature'?'⭐ Featured + published':'✅ Published');}
      else{alert('Failed: '+(j.error||'error'));}
    }).catch(function(){alert('Network error');});
 }
</script>
</body></html>`);
});

export default router;
