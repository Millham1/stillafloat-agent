import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Send, Eye, EyeOff, CheckSquare, Square, Newspaper, AlertTriangle } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

type Story = {
  id: string;
  title?: string | null;
  summary?: string | null;
  impactLevel?: string | null;
  travelerImpact?: string | null;
  category?: string | null;
  link?: string | null;
  originalLink?: string | null;
  status?: string | null;
};

type ApprovedResponse = { stories: Story[] };

const IMPACT_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300",
  high:     "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300",
  medium:   "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300",
  low:      "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300",
};

export default function Newsletter() {
  const { toast } = useToast();
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [subject, setSubject]     = useState("Still Afloat Weekly: Cruise News & Travel Intel");
  const [sending, setSending]     = useState(false);
  const [showPreview, setPreview] = useState(false);
  const [sendResult, setResult]   = useState<{ sent: number; failed: number; total: number } | null>(null);

  const { data, isLoading } = useQuery<ApprovedResponse>({
    queryKey: ["approved-stories-list"],
    queryFn:  () => fetch("/api/approved-stories-list", { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 60_000,
  });

  const stories = (data?.stories ?? []).filter(
    (s) => s.status === "approved" || s.status === "featured",
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === stories.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(stories.map((s) => s.id)));
    }
  }

  async function handleSend() {
    if (!subject.trim()) return toast({ variant: "destructive", title: "Subject required" });
    if (selected.size === 0) return toast({ variant: "destructive", title: "Select at least one story" });

    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/send-newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ storyIds: Array.from(selected), subject }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ variant: "destructive", title: "Send failed", description: data.error });
      } else {
        setResult(data);
        toast({
          title: "Newsletter sent!",
          description: `Delivered to ${data.sent} of ${data.total} subscribers.`,
        });
      }
    } catch {
      toast({ variant: "destructive", title: "Network error", description: "Could not reach the server." });
    } finally {
      setSending(false);
    }
  }

  const selectedStories = stories.filter((s) => selected.has(s.id));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold tracking-tight">Send Newsletter</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pick approved stories below, write a subject line, and send to all confirmed subscribers.
        </p>
      </div>

      {/* Send result banner */}
      {sendResult && (
        <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800 p-4 flex items-center gap-3">
          <Send className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0" />
          <div>
            <p className="font-semibold text-green-900 dark:text-green-200">
              Newsletter delivered to {sendResult.sent}/{sendResult.total} subscribers
            </p>
            {sendResult.failed > 0 && (
              <p className="text-sm text-green-700 dark:text-green-300 mt-0.5">
                {sendResult.failed} failed — check server logs for details
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: story picker */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">
              Approved Stories
              <span className="ml-2 text-muted-foreground font-normal">({stories.length})</span>
            </span>
            {stories.length > 0 && (
              <button
                onClick={toggleAll}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                {selected.size === stories.length
                  ? <><CheckSquare className="w-3.5 h-3.5" /> Deselect all</>
                  : <><Square className="w-3.5 h-3.5" /> Select all</>}
              </button>
            )}
          </div>

          {isLoading && (
            <div className="text-sm text-muted-foreground py-6 text-center">Loading stories…</div>
          )}
          {!isLoading && stories.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Newspaper className="w-8 h-8 opacity-30" />
              <p className="text-sm">No approved stories yet.</p>
              <p className="text-xs">Approve stories from the Editorial Queue first.</p>
            </div>
          )}

          {stories.map((story) => {
            const isSelected = selected.has(story.id);
            const impact = (story.impactLevel || "").toLowerCase();
            return (
              <div
                key={story.id}
                onClick={() => toggle(story.id)}
                className={`cursor-pointer rounded-lg border p-4 transition-all ${
                  isSelected
                    ? "border-primary bg-primary/5 dark:bg-primary/10"
                    : "border-border bg-card hover:bg-muted/30"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                    isSelected ? "bg-primary border-primary" : "border-muted-foreground/30"
                  }`}>
                    {isSelected && <span className="text-[10px] text-primary-foreground font-bold">✓</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {impact && (
                        <Badge variant="outline" className={IMPACT_COLORS[impact] ?? ""}>
                          {story.impactLevel}
                        </Badge>
                      )}
                      {story.category && (
                        <Badge variant="outline" className="text-xs">{story.category}</Badge>
                      )}
                      {story.status === "featured" && (
                        <Badge variant="outline" className="bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300">
                          ⭐ Featured
                        </Badge>
                      )}
                    </div>
                    <p className="font-semibold text-sm leading-snug mb-1">
                      {story.title || "Untitled"}
                    </p>
                    {story.summary && (
                      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                        {story.summary}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right: compose + send */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-5 space-y-4">
              <h3 className="font-semibold text-sm">Compose</h3>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Subject Line
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-md border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="Newsletter subject…"
                />
              </div>

              <div className="text-xs text-muted-foreground space-y-1 border rounded-md p-3 bg-muted/20">
                <div className="flex justify-between">
                  <span>Stories selected</span>
                  <span className="font-semibold text-foreground">{selected.size}</span>
                </div>
                <div className="flex justify-between">
                  <span>Recipients</span>
                  <span className="font-semibold text-foreground">confirmed subscribers</span>
                </div>
              </div>

              {selected.size === 0 && (
                <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  Select at least one story to send.
                </div>
              )}

              <div className="flex flex-col gap-2">
                <button
                  onClick={() => setPreview((p) => !p)}
                  disabled={selected.size === 0}
                  className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-md border bg-card text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  {showPreview ? "Hide Preview" : "Preview Selected"}
                </button>

                <button
                  onClick={handleSend}
                  disabled={sending || selected.size === 0}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className={`w-4 h-4 ${sending ? "animate-pulse" : ""}`} />
                  {sending ? "Sending…" : "Send to All Subscribers"}
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Preview pane */}
          {showPreview && selectedStories.length > 0 && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Eye className="w-3.5 h-3.5" /> Preview ({selectedStories.length} stories)
                </h3>
                <p className="text-xs text-muted-foreground">Subject: <span className="font-medium text-foreground">{subject}</span></p>
                <div className="space-y-3 max-h-80 overflow-y-auto">
                  {selectedStories.map((s) => (
                    <div key={s.id} className="border rounded-md p-3 bg-background text-xs space-y-1">
                      <p className="font-semibold leading-snug">{s.title || "Untitled"}</p>
                      <p className="text-muted-foreground line-clamp-3 leading-relaxed">{s.summary}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
