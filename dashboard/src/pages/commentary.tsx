import React, { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  MessageSquare, Plus, Pencil, Trash2, EyeOff, Eye,
  Mic, Languages, Loader2, X, Tag, Youtube, Image,
} from "lucide-react";

import { authHeaders } from "@/lib/auth-token";

const API = "";

// ── Types ──────────────────────────────────────────────────────────────────
interface CommentaryPost {
  id: string;
  title: string;
  body_en: string;
  body_es: string;
  tags: string[];
  status: "published" | "unpublished";
  published_at: string;
  updated_at: string;
  videoUrl?: string;
  imageUrl?: string;
}

// ── API helpers ────────────────────────────────────────────────────────────
async function fetchPosts(): Promise<CommentaryPost[]> {
  const res = await fetch(`${API}/api/commentary?status=all`, {
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Failed to load posts");
  return data.posts as CommentaryPost[];
}

async function createPost(body: {
  title: string;
  body_en: string;
  body_es: string;
  tags: string[];
  videoUrl?: string;
  imageUrl?: string;
}): Promise<CommentaryPost> {
  const res = await fetch(`${API}/api/commentary`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Failed to create post");
  return data.post as CommentaryPost;
}

async function updatePost(id: string, body: Partial<CommentaryPost>): Promise<CommentaryPost> {
  const res = await fetch(`${API}/api/commentary/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Failed to update post");
  return data.post as CommentaryPost;
}

async function deletePost(id: string): Promise<void> {
  const res = await fetch(`${API}/api/commentary/${id}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Failed to delete post");
}

async function translateText(text: string): Promise<string> {
  const res = await fetch(`${API}/api/translate-commentary`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Translation failed");
  return data.translation as string;
}

async function transcribeAudio(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(arrayBuffer).reduce((acc, byte) => acc + String.fromCharCode(byte), "")
  );
  const res = await fetch(`${API}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ audioBase64: base64, fileName: file.name, mimeType: file.type }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Transcription failed");
  return data.transcript as string;
}

// ── Empty form state ────────────────────────────────────────────────────────
const emptyForm = () => ({
  title: "",
  body_en: "",
  body_es: "",
  tags: "",
  videoUrl: "",
  imageUrl: "",
});

// ── Format date ─────────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch { return iso; }
}

// ── Main component ──────────────────────────────────────────────────────────
export default function CommentaryManager() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const QUERY_KEY = ["commentary-posts"];

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [translating, setTranslating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  // ── Queries & mutations ──────────────────────────────────────────────────
  const { data: posts = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchPosts,
  });

  const createMutation = useMutation({
    mutationFn: createPost,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      closeModal();
      toast({ title: "Post published", description: "Commentary post is now live." });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Failed to publish", description: e.message }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CommentaryPost> }) => updatePost(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      closeModal();
      toast({ title: "Post updated" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Update failed", description: e.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: deletePost,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      setConfirmDeleteId(null);
      toast({ title: "Post deleted" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Delete failed", description: e.message }),
  });

  // ── Modal helpers ─────────────────────────────────────────────────────────
  function openNew() {
    setEditId(null);
    setForm(emptyForm());
    setModalOpen(true);
  }

  function openEdit(post: CommentaryPost) {
    setEditId(post.id);
    setForm({
      title: post.title,
      body_en: post.body_en,
      body_es: post.body_es,
      tags: post.tags.join(", "),
      videoUrl: post.videoUrl ?? "",
      imageUrl: post.imageUrl ?? "",
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditId(null);
    setForm(emptyForm());
  }

  // ── Translate ─────────────────────────────────────────────────────────────
  async function handleTranslate() {
    if (!form.body_en.trim()) {
      toast({ variant: "destructive", title: "Nothing to translate", description: "Write the English commentary first." });
      return;
    }
    setTranslating(true);
    try {
      const translation = await translateText(form.body_en);
      setForm(f => ({ ...f, body_es: translation }));
      toast({ title: "Translated", description: "Spanish version is ready — review and edit as needed." });
    } catch (e) {
      toast({ variant: "destructive", title: "Translation failed", description: (e as Error).message });
    } finally {
      setTranslating(false);
    }
  }

  // ── Transcribe ────────────────────────────────────────────────────────────
  async function handleAudioFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setTranscribing(true);
    try {
      const transcript = await transcribeAudio(file);
      setForm(f => ({ ...f, body_en: transcript }));
      toast({ title: "Transcribed", description: "Review and edit the transcript before publishing." });
    } catch (err) {
      toast({ variant: "destructive", title: "Transcription failed", description: (err as Error).message });
    } finally {
      setTranscribing(false);
      if (audioInputRef.current) audioInputRef.current.value = "";
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = form.tags.split(",").map(t => t.trim()).filter(Boolean);
    const videoUrl = form.videoUrl.trim() || undefined;
    const imageUrl = form.imageUrl.trim() || undefined;
    if (editId) {
      updateMutation.mutate({
        id: editId,
        body: { title: form.title, body_en: form.body_en, body_es: form.body_es, tags, videoUrl, imageUrl },
      });
    } else {
      createMutation.mutate({
        title: form.title,
        body_en: form.body_en,
        body_es: form.body_es,
        tags,
        videoUrl,
        imageUrl,
      });
    }
  }

  const saving = createMutation.isPending || updateMutation.isPending;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Commentary</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Mark's personal takes, vlog transcripts, and travel stories
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Post
        </button>
      </div>

      {/* Posts list */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading posts…</span>
        </div>
      ) : posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-52 text-muted-foreground gap-3 border border-dashed rounded-lg">
          <MessageSquare className="w-10 h-10 opacity-30" />
          <p className="text-sm">No commentary posts yet. Click <strong>New Post</strong> to write one.</p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium">Tags</th>
                <th className="text-left px-4 py-2.5 font-medium">Media</th>
                <th className="text-left px-4 py-2.5 font-medium">Date</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post, i) => (
                <tr key={post.id} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                  <td className="px-4 py-3 font-medium max-w-[260px]">
                    <div className="truncate">{post.title}</div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {post.body_en?.slice(0, 80)}{post.body_en?.length > 80 ? "…" : ""}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {post.tags.slice(0, 3).map(t => (
                        <span key={t} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-secondary text-secondary-foreground">
                          <Tag className="w-2.5 h-2.5" />{t}
                        </span>
                      ))}
                      {post.tags.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{post.tags.length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {post.videoUrl && (
                        <span title="Has YouTube video" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-400">
                          <Youtube className="w-2.5 h-2.5" /> Video
                        </span>
                      )}
                      {post.imageUrl && (
                        <span title="Has image" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400">
                          <Image className="w-2.5 h-2.5" /> Image
                        </span>
                      )}
                      {!post.videoUrl && !post.imageUrl && (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtDate(post.published_at)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                      post.status === "published"
                        ? "bg-green-500/15 text-green-400"
                        : "bg-yellow-500/15 text-yellow-400"
                    }`}>
                      {post.status === "published" ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      {post.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openEdit(post)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 hover:bg-primary/20 text-primary font-semibold text-xs transition-colors"
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      <button
                        title={post.status === "published" ? "Unpublish" : "Republish"}
                        onClick={() => updateMutation.mutate({
                          id: post.id,
                          body: { status: post.status === "published" ? "unpublished" : "published" },
                        })}
                        className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {post.status === "published" ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        title="Delete"
                        onClick={() => setConfirmDeleteId(post.id)}
                        className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New / Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeModal} />
          <div className="relative z-10 bg-card border rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="font-semibold text-base">
                {editId ? "Edit Post" : "New Commentary Post"}
              </h3>
              <button onClick={closeModal} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-5">
              {/* Title */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Title <span className="text-destructive">*</span></label>
                <input
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  required
                  placeholder="What's this post about?"
                  className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* English body */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">
                    Commentary (English) <span className="text-destructive">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => audioInputRef.current?.click()}
                    disabled={transcribing}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-input hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    {transcribing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mic className="w-3 h-3" />}
                    {transcribing ? "Transcribing…" : "Upload Audio"}
                  </button>
                </div>
                <input
                  ref={audioInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={handleAudioFile}
                />
                <textarea
                  value={form.body_en}
                  onChange={e => setForm(f => ({ ...f, body_en: e.target.value }))}
                  required
                  rows={10}
                  placeholder="Paste your transcript or write your commentary here…&#10;&#10;Use double line breaks to separate paragraphs."
                  className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
                />
                <p className="text-xs text-muted-foreground">{form.body_en.length.toLocaleString()} characters</p>
              </div>

              {/* Spanish translation */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Commentary (Spanish)</label>
                  <button
                    type="button"
                    onClick={handleTranslate}
                    disabled={translating || !form.body_en.trim()}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-input hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    {translating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Languages className="w-3 h-3" />}
                    {translating ? "Translating…" : "Auto-Translate"}
                  </button>
                </div>
                <textarea
                  value={form.body_es}
                  onChange={e => setForm(f => ({ ...f, body_es: e.target.value }))}
                  rows={8}
                  placeholder="Spanish translation will appear here after clicking Auto-Translate — you can edit it before publishing."
                  className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
                />
              </div>

              {/* Tags */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Tags</label>
                <input
                  value={form.tags}
                  onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                  placeholder="Caribbean, tips, personal story  (comma-separated)"
                  className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">Separate tags with commas</p>
              </div>

              {/* Rich media */}
              <div className="rounded-lg border border-dashed border-input p-4 space-y-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Rich Media (optional)</p>

                {/* YouTube URL */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium flex items-center gap-1.5">
                    <Youtube className="w-4 h-4 text-red-400" />
                    YouTube Video URL
                  </label>
                  <input
                    type="url"
                    value={form.videoUrl}
                    onChange={e => setForm(f => ({ ...f, videoUrl: e.target.value }))}
                    placeholder="https://www.youtube.com/watch?v=… or https://youtu.be/…"
                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p className="text-xs text-muted-foreground">Paste any YouTube link — it will be embedded above the post body.</p>
                </div>

                {/* Image URL */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium flex items-center gap-1.5">
                    <Image className="w-4 h-4 text-blue-400" />
                    Hero Image URL
                  </label>
                  <input
                    type="url"
                    value={form.imageUrl}
                    onChange={e => setForm(f => ({ ...f, imageUrl: e.target.value }))}
                    placeholder="https://example.com/photo.jpg"
                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p className="text-xs text-muted-foreground">A photo displayed above the text. When both a video and an image are provided, the video appears first and the image appears beneath it.</p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm rounded-md border border-input hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !form.title.trim() || !form.body_en.trim()}
                  className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-semibold transition-colors"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {editId ? "Save Changes" : "Publish Post"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmDeleteId(null)} />
          <div className="relative z-10 bg-card border rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="font-semibold">Delete Post?</h3>
            <p className="text-sm text-muted-foreground">This cannot be undone. The post will be permanently removed.</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2 text-sm rounded-md border border-input hover:bg-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmDeleteId && deleteMutation.mutate(confirmDeleteId)}
                disabled={deleteMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 font-semibold transition-colors"
              >
                {deleteMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
