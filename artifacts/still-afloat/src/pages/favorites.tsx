import React, { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Heart, Trash2, Pencil, Plus, X, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = [
  { value: "youtube-channels", label: "YouTube Channels", icon: "▶️" },
  { value: "cruise-websites",  label: "Cruise Websites",  icon: "🌐" },
];

interface FavoriteItem {
  id: string;
  title: string;
  url: string;
  category: "youtube-channels" | "cruise-websites";
  description: string;
  imageUrl: string;
  sortOrder: number;
  createdAt: string;
}

const EMPTY_FORM = {
  title: "",
  url: "",
  category: "youtube-channels" as FavoriteItem["category"],
  description: "",
  imageUrl: "",
  sortOrder: 0,
};

type FormState = typeof EMPTY_FORM;

export default function FavoritesManager() {
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const { toast } = useToast();

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/favorites");
      const data = await resp.json();
      setItems(data.items || []);
    } catch {
      toast({ variant: "destructive", title: "Load failed", description: "Could not fetch favorites." });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadItems(); }, [loadItems]);

  function openAdd() {
    setEditId(null);
    setForm({ ...EMPTY_FORM, sortOrder: items.length });
    setShowModal(true);
  }

  function openEdit(item: FavoriteItem) {
    setEditId(item.id);
    setForm({
      title: item.title,
      url: item.url,
      category: item.category,
      description: item.description,
      imageUrl: item.imageUrl,
      sortOrder: item.sortOrder,
    });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.url.trim()) return;
    setSaving(true);
    try {
      const method = editId ? "PATCH" : "POST";
      const endpoint = editId ? `/api/favorites/${editId}` : "/api/favorites";
      const resp = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      toast({ title: editId ? "Updated" : "Added", description: `"${form.title}" saved.` });
      closeModal();
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
      const resp = await fetch(`/api/favorites/${id}`, { method: "DELETE" });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      toast({ title: "Deleted" });
      loadItems();
    } catch (err) {
      toast({ variant: "destructive", title: "Delete failed", description: (err as Error).message });
    }
  }

  const grouped = CATEGORIES.map((cat) => ({
    ...cat,
    items: items.filter((i) => i.category === cat.value),
  }));

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Favorites Manager</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Curated YouTube channels and cruise websites displayed at{" "}
            <a href="/favorites.html" target="_blank" rel="noopener noreferrer"
               className="underline underline-offset-2 hover:text-foreground">/favorites.html</a>
            . {items.length} entries across {CATEGORIES.length} categories.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium transition-colors flex-shrink-0"
        >
          <Plus className="w-4 h-4" /> Add Favorite
        </button>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <Card className="w-full max-w-lg shadow-2xl">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Heart className="w-4 h-4" />
                {editId ? "Edit Favorite" : "Add Favorite"}
              </CardTitle>
              <button onClick={closeModal} className="p-1 rounded hover:bg-accent transition-colors">
                <X className="w-4 h-4" />
              </button>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Title *</label>
                    <input
                      value={form.title}
                      onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                      placeholder="e.g. Gone With The Wynns"
                      required
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Category *</label>
                    <select
                      value={form.category}
                      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as FavoriteItem["category"] }))}
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">URL *</label>
                  <div className="flex gap-2">
                    <input
                      value={form.url}
                      onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                      placeholder="https://..."
                      required
                      className="flex-1 px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    <button
                      type="button"
                      onClick={() => form.url && window.open(form.url, "_blank")}
                      disabled={!form.url.trim()}
                      title="Test this link"
                      className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-md border bg-background hover:bg-accent disabled:opacity-40 transition-colors flex-shrink-0 font-medium"
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> Test
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder="One or two sentences about why this is worth bookmarking."
                    rows={2}
                    className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Image URL</label>
                    <input
                      value={form.imageUrl}
                      onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
                      placeholder="https://... (logo or thumbnail)"
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sort Order</label>
                    <input
                      type="number"
                      value={form.sortOrder}
                      onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
                      min={0}
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                </div>

                <div className="flex justify-end pt-2 border-t">
                  <button
                    type="submit"
                    disabled={saving || !form.title.trim() || !form.url.trim()}
                    className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold disabled:opacity-60 transition-colors"
                  >
                    {saving ? "Saving…" : editId ? "Save Changes" : "Add to Website"}
                  </button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground animate-pulse py-6">Loading favorites…</div>
      ) : (
        <div className="space-y-8">
          {grouped.map((cat) => (
            <div key={cat.value}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-base">{cat.icon}</span>
                <h3 className="font-semibold text-sm">{cat.label}</h3>
                <Badge variant="outline" className="text-xs font-mono">{cat.items.length}</Badge>
                <a
                  href="/favorites.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="w-3 h-3" /> View page
                </a>
              </div>

              {cat.items.length === 0 ? (
                <p className="text-sm text-muted-foreground pl-6 pb-2">No entries yet — use "Add Favorite" above.</p>
              ) : (
                <div className="space-y-2">
                  {cat.items.map((item) => (
                    <Card key={item.id}>
                      <CardContent className="p-4 flex items-start gap-4">
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            className="w-12 h-12 rounded-lg object-cover flex-shrink-0 border border-border bg-muted"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-lg flex-shrink-0 border border-border bg-muted flex items-center justify-center text-lg">
                            {cat.icon}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="font-semibold text-sm truncate">{item.title}</span>
                            <Badge variant="secondary" className="text-[10px] font-mono shrink-0">#{item.sortOrder}</Badge>
                          </div>
                          {item.description && (
                            <p className="text-xs text-muted-foreground line-clamp-1 mb-1">{item.description}</p>
                          )}
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-blue-500 hover:underline truncate block"
                          >
                            {item.url}
                          </a>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => openEdit(item)}
                            title="Edit"
                            className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          >
                            <Pencil className="w-4 h-4" />
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
