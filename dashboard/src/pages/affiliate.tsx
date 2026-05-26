import React, { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShoppingBag, Trash2, Star, Plus, X, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = [
  { value: "air-travel", label: "Air Travel", icon: "✈️" },
  { value: "cabin-essentials", label: "Cruise Cabin Essentials", icon: "🛏️" },
  { value: "cruise-fun", label: "Cruise Fun!", icon: "🏖️" },
  { value: "great-ideas", label: "Generally Great Ideas", icon: "💡" },
];

const CATEGORY_PAGES: Record<string, string> = {
  "air-travel": "/affiliate/air-travel.html",
  "cabin-essentials": "/affiliate/cabin-essentials.html",
  "cruise-fun": "/affiliate/cruise-fun.html",
  "great-ideas": "/affiliate/great-ideas.html",
};

interface AffiliateItem {
  id: string;
  title: string;
  description: string;
  category: string;
  smartStrip: string;
  imageUrl: string;
  featured: boolean;
  createdAt: string;
  sortOrder: number;
}

const API_BASE = "";

const EMPTY_FORM = {
  title: "",
  description: "",
  category: "air-travel",
  smartStrip: "",
  affiliateLink: "",
  imageUrl: "",
  featured: false,
};

export default function AffiliateManager() {
  const [items, setItems] = useState<AffiliateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const { toast } = useToast();

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/affiliate-items`);
      const data = await resp.json();
      setItems(data.items || []);
    } catch {
      toast({ variant: "destructive", title: "Load failed", description: "Could not fetch affiliate items." });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadItems(); }, [loadItems]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const resp = await fetch(`${API_BASE}/api/affiliate-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      toast({ title: "Item added", description: `"${form.title}" added to ${CATEGORIES.find(c => c.value === form.category)?.label}.` });
      setForm(EMPTY_FORM);
      setShowForm(false);
      loadItems();
    } catch (err) {
      toast({ variant: "destructive", title: "Save failed", description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string, title: string) {
    if (!confirm(`Delete "${title}"?`)) return;
    try {
      const resp = await fetch(`${API_BASE}/api/affiliate-items/${id}`, { method: "DELETE" });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      toast({ title: "Deleted" });
      loadItems();
    } catch (err) {
      toast({ variant: "destructive", title: "Delete failed", description: (err as Error).message });
    }
  }

  async function toggleFeatured(item: AffiliateItem) {
    try {
      const resp = await fetch(`${API_BASE}/api/affiliate-items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featured: !item.featured }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      loadItems();
    } catch (err) {
      toast({ variant: "destructive", title: "Update failed", description: (err as Error).message });
    }
  }

  const grouped = CATEGORIES.map(cat => ({
    ...cat,
    items: items.filter(i => i.category === cat.value),
  }));

  const totalFeatured = items.filter(i => i.featured).length;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Affiliate Manager</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Paste an Amazon Smart Strip, add an image, pick a category — it goes live on the website instantly.
            {totalFeatured > 0 && ` · ${totalFeatured} featured on the Gear landing page.`}
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium transition-colors flex-shrink-0"
        >
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showForm ? "Cancel" : "Add Item"}
        </button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShoppingBag className="w-4 h-4" /> New Affiliate Item
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Title *</label>
                  <input
                    value={form.title}
                    onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                    placeholder="e.g. Compression Packing Cubes Set"
                    required
                    className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Category *</label>
                  <select
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    {CATEGORIES.map(c => (
                      <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="One or two sentences about why this is worth picking up."
                  rows={2}
                  className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Image URL</label>
                <input
                  value={form.imageUrl}
                  onChange={e => setForm(f => ({ ...f, imageUrl: e.target.value }))}
                  placeholder="https://..."
                  className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <p className="text-xs text-muted-foreground">Direct link to a product image (Amazon image URL, your own hosted photo, etc.)</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Affiliate Link URL</label>
                <input
                  value={form.affiliateLink}
                  onChange={e => setForm(f => ({ ...f, affiliateLink: e.target.value }))}
                  placeholder="https://www.amazon.com/dp/ASIN?tag=yourtag-20"
                  className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <p className="text-xs text-muted-foreground">Your tagged Amazon affiliate URL — this is what the "More Info" button links to.</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Amazon Smart Strip HTML</label>
                <textarea
                  value={form.smartStrip}
                  onChange={e => setForm(f => ({ ...f, smartStrip: e.target.value }))}
                  placeholder={`<script type="text/javascript">\namzn_assoc_placement = "adunit0";\n...\n</script>\n<script src="//z-na.amazon-adsystem.com/..."></script>`}
                  rows={7}
                  className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary font-mono resize-y"
                />
                <p className="text-xs text-muted-foreground">
                  From Amazon Associates → Product Linking → Link Builder. Copy the full embed code and paste it here.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="featured-check"
                  type="checkbox"
                  checked={form.featured}
                  onChange={e => setForm(f => ({ ...f, featured: e.target.checked }))}
                  className="rounded"
                />
                <label htmlFor="featured-check" className="text-sm font-medium cursor-pointer">
                  Feature this item on the main Cruising Gear page
                </label>
              </div>

              <div className="flex justify-end pt-2 border-t">
                <button
                  type="submit"
                  disabled={saving || !form.title.trim()}
                  className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold disabled:opacity-60 transition-colors"
                >
                  {saving ? "Saving…" : "Add to Website"}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground animate-pulse py-6">Loading affiliate items…</div>
      ) : (
        <div className="space-y-8">
          {grouped.map(cat => (
            <div key={cat.value}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-base">{cat.icon}</span>
                <h3 className="font-semibold text-sm">{cat.label}</h3>
                <Badge variant="outline" className="text-xs font-mono">{cat.items.length}</Badge>
                <a
                  href={CATEGORY_PAGES[cat.value]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="w-3 h-3" /> View page
                </a>
              </div>

              {cat.items.length === 0 ? (
                <p className="text-sm text-muted-foreground pl-6 pb-2">No items yet — use "Add Item" above.</p>
              ) : (
                <div className="space-y-2">
                  {cat.items.map(item => (
                    <Card key={item.id} className={item.featured ? "border-yellow-400/40 ring-1 ring-yellow-400/20" : ""}>
                      <CardContent className="p-4 flex items-start gap-4">
                        {item.imageUrl && (
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            className="w-14 h-14 rounded-lg object-cover flex-shrink-0 border border-border"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {item.featured && (
                              <Badge className="bg-yellow-500/15 text-yellow-600 border-yellow-500/30 text-xs gap-1 py-0">
                                <Star className="w-2.5 h-2.5 fill-current" /> Featured
                              </Badge>
                            )}
                            <span className="font-semibold text-sm truncate">{item.title}</span>
                          </div>
                          {item.description && (
                            <p className="text-xs text-muted-foreground line-clamp-2 mb-1">{item.description}</p>
                          )}
                          {item.smartStrip && (
                            <p className="text-[11px] text-muted-foreground/50 font-mono truncate">
                              Smart Strip: {item.smartStrip.substring(0, 55)}…
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => toggleFeatured(item)}
                            title={item.featured ? "Remove from featured" : "Feature on Gear page"}
                            className={`p-1.5 rounded-md transition-colors ${
                              item.featured
                                ? "text-yellow-500 hover:bg-yellow-500/10"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground"
                            }`}
                          >
                            <Star className={`w-4 h-4 ${item.featured ? "fill-current" : ""}`} />
                          </button>
                          <button
                            onClick={() => handleDelete(item.id, item.title)}
                            className="p-1.5 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
