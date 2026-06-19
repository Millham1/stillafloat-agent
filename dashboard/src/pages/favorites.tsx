import React, { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Heart, Trash2, Pencil, Plus, X, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { authHeaders } from "@/lib/auth-token";

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
        headers: { "Content-Type": "application/json", ...authHeaders() },
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
      const resp = await fetch(`/api/favorites/${id}`, { method: "DELETE", headers: { ...authHeaders() } });
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
                      <ExternalLink className="w-3.5 h-3.5" /> Test Link
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
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6">No favorites yet — use "Add Favorite" above to get started.</p>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="px-4 py-3 text-left font-semibold">Title</th>
                  <th className="px-4 py-3 text-left font-semibold">Category</th>
                  <th className="px-4 py-3 text-left font-semibold hidden sm:table-cell">Description</th>
                  <th className="px-4 py-3 text-center font-semibold w-16">Order</th>
                  <th className="px-4 py-3 text-right font-semibold w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const cat = CATEGORIES.find((c) => c.value === item.category);
                  return (
                    <tr key={item.id} className="border-b last:border-0 hover:bg-muted/40 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={item.title}
                              className="w-9 h-9 rounded-md object-cover flex-shrink-0 border border-border bg-muted"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-md flex-shrink-0 border border-border bg-muted flex items-center justify-center text-sm">
                              {cat?.icon ?? "★"}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[180px]">{item.title}</div>
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-blue-500 hover:underline truncate block max-w-[180px]"
                            >
                              {item.url}
                            </a>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs whitespace-nowrap">
                          {cat?.icon} {cat?.label ?? item.category}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <p className="text-xs text-muted-foreground line-clamp-2 max-w-[240px]">
                          {item.description || <span className="italic opacity-50">—</span>}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs font-mono text-muted-foreground">{item.sortOrder}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
