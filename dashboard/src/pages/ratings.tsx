// Ratings — the "Conga Line" ship-rating admin page.
//
// A crowd-sourced 1-5 audience score (never negative — Mark works under a host
// agency and doesn't want a real ship ever carrying an official worst-possible
// verdict) built by manually reading Cruiseline.com + CruiseCritic's public
// review aggregates (both sites bar bot access; a human reads and types in
// what they see — Tripadvisor is deliberately excluded). Quarterly, human-
// checked, never live.
//
// Every rating carries TWO separate voices: `comment` (warm paraphrase of real
// review themes, Mark's advisor voice) and `salty_grump_take` (a separate, always-
// present dry/skeptical aside — the Rotten-Tomatoes critics-vs-audience split;
// not a rating value, not on the 1-5 scale).
//
// Workflow, per ship: enter both sources' scores + free-text themes -> Draft
// (one Haiku call computes the blended rating + drafts both text fields for
// review) -> edit if needed -> Save as draft -> Publish (separate, explicit
// action — nothing goes live on Save alone).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sparkles, Save, Rocket, Undo2 } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";
import { useToast } from "@/hooks/use-toast";

type SourceRow = {
  ship_slug: string; source: "cruiseline" | "cruisecritic";
  source_score: number | null; source_scale: number | null; review_count: number | null;
  source_url: string | null; notes: string | null; captured_at: string; captured_by: string | null;
};
type RatingRow = {
  ship_slug: string; rating: number | null; rating_display: string | null;
  comment: string | null; salty_grump_take: string | null;
  comment_status: "draft" | "approved"; status: "draft" | "published";
  source_count: number | null; computed_at: string | null; refresh_due_at: string | null;
};

// Small reusable "5 dancer silhouettes" preview — same visual language as the
// public congaLineSvg() in cabin-finder.html, ported to a TS string here so
// the admin can preview the icon next to a candidate/saved rating.
function congaLineSvg(rating: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  let out = "";
  for (let i = 0; i < 5; i++) {
    const on = i < filled;
    const color = on ? "#5dff9a" : "rgba(120,130,150,.35)";
    out += `<svg viewBox="0 0 20 28" width="16" height="22" aria-hidden="true" style="display:inline-block;margin-right:1px">
      <circle cx="10" cy="4" r="3.4" fill="${color}"/>
      <path d="M10 8 L10 16 M10 10 L4 8 M10 10 L17 13 M10 16 L5 26 M10 16 L15 22" stroke="${color}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    </svg>`;
  }
  return out;
}

function ShipDancers({ rating }: { rating: number }) {
  // eslint-disable-next-line react/no-danger
  return <span dangerouslySetInnerHTML={{ __html: congaLineSvg(rating) }} />;
}

type SourceInputState = { score: string; scale: string; count: string; url: string };
const emptySource: SourceInputState = { score: "", scale: "5", count: "", url: "" };

function useAdminData() {
  return useQuery<{ ok: boolean; ratings: RatingRow[]; sources: SourceRow[] }>({
    queryKey: ["conga-line-admin"],
    queryFn: () => fetch("/api/admin/conga-line", { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 30_000,
  });
}

export default function Ratings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const admin = useAdminData();

  const [shipSlug, setShipSlug] = useState("wonder-of-the-seas");
  const [shipName, setShipName] = useState("Wonder of the Seas");
  const [cruiseline, setCruiseline] = useState<SourceInputState>(emptySource);
  const [cruisecritic, setCruisecritic] = useState<SourceInputState>(emptySource);
  const [themes, setThemes] = useState("");

  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Candidate fields shown after "Draft" — editable before Save.
  const [candidate, setCandidate] = useState<{ rating: number; ratingDisplay: string; sourceCount: number; comment: string; saltyGrumpTake: string } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["conga-line-admin"] });

  const draft = async () => {
    setDrafting(true);
    try {
      const r = await fetch(`/api/admin/conga-line/${shipSlug}/draft-comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          ship: shipName,
          cruiseline: cruiseline.score ? { score: cruiseline.score, scale: cruiseline.scale, count: cruiseline.count, url: cruiseline.url } : undefined,
          cruisecritic: cruisecritic.score ? { score: cruisecritic.score, scale: cruisecritic.scale, count: cruisecritic.count, url: cruisecritic.url } : undefined,
          themes,
        }),
      });
      const body = (await r.json()) as { ok?: boolean; error?: string; rating?: number; ratingDisplay?: string; sourceCount?: number; comment?: string; saltyGrumpTake?: string };
      if (!body.ok) throw new Error(body.error || "Draft failed");
      setCandidate({
        rating: body.rating!, ratingDisplay: body.ratingDisplay!, sourceCount: body.sourceCount!,
        comment: body.comment!, saltyGrumpTake: body.saltyGrumpTake!,
      });
      toast({ title: "Draft ready", description: "Review the rating, comment and Salty Grump take below before saving." });
    } catch (err) {
      toast({ variant: "destructive", title: "Draft failed", description: (err as Error).message });
    } finally {
      setDrafting(false);
    }
  };

  const saveSourcesFirst = async () => {
    // Persist whichever source scores were entered so the audit trail
    // (conga_line_sources) stays current, independent of the draft/save flow.
    const calls: Promise<Response>[] = [];
    if (cruiseline.score) {
      calls.push(fetch(`/api/admin/conga-line/${shipSlug}/sources`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ source: "cruiseline", sourceScore: cruiseline.score, sourceScale: cruiseline.scale, reviewCount: cruiseline.count, sourceUrl: cruiseline.url, notes: themes }),
      }));
    }
    if (cruisecritic.score) {
      calls.push(fetch(`/api/admin/conga-line/${shipSlug}/sources`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ source: "cruisecritic", sourceScore: cruisecritic.score, sourceScale: cruisecritic.scale, reviewCount: cruisecritic.count, sourceUrl: cruisecritic.url, notes: themes }),
      }));
    }
    await Promise.all(calls);
  };

  const save = async () => {
    if (!candidate) return;
    setSaving(true);
    try {
      await saveSourcesFirst();
      const r = await fetch(`/api/admin/conga-line/${shipSlug}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          rating: candidate.rating, ratingDisplay: candidate.ratingDisplay, sourceCount: candidate.sourceCount,
          comment: candidate.comment, saltyGrumpTake: candidate.saltyGrumpTake,
        }),
      });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      if (!body.ok) throw new Error(body.error || "Save failed");
      toast({ title: "Saved as draft", description: "Not live yet — Publish when you're happy with it." });
      refresh();
    } catch (err) {
      toast({ variant: "destructive", title: "Save failed", description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const publish = async (slug: string) => {
    setPublishing(true);
    try {
      const r = await fetch(`/api/admin/conga-line/${slug}/publish`, { method: "POST", headers: { ...authHeaders() } });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      if (!body.ok) throw new Error(body.error || "Publish failed");
      toast({ title: "Published", description: `${slug} is now live on the site.` });
      refresh();
    } catch (err) {
      toast({ variant: "destructive", title: "Publish failed", description: (err as Error).message });
    } finally {
      setPublishing(false);
    }
  };

  const unpublish = async (slug: string) => {
    try {
      const r = await fetch(`/api/admin/conga-line/${slug}/unpublish`, { method: "POST", headers: { ...authHeaders() } });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      if (!body.ok) throw new Error(body.error || "Failed");
      toast({ title: "Reverted to draft" });
      refresh();
    } catch (err) {
      toast({ variant: "destructive", title: "Failed", description: (err as Error).message });
    }
  };

  const ratings = admin.data?.ratings ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Ratings — Conga Line</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Crowd score (1–5, never lower) from Cruiseline.com + CruiseCritic, read by hand each quarter — plus the
          Salty Grump's separate dry take. Nothing goes live until you Publish.
        </p>
      </div>

      {/* Entry form */}
      <Card className="p-4 space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Ship slug</Label>
            <Input value={shipSlug} onChange={(e) => setShipSlug(e.target.value)} placeholder="wonder-of-the-seas" />
          </div>
          <div>
            <Label className="text-xs">Ship display name</Label>
            <Input value={shipName} onChange={(e) => setShipName(e.target.value)} placeholder="Wonder of the Seas" />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2 border rounded-md p-3">
            <div className="text-sm font-semibold">Cruiseline.com</div>
            <div className="grid grid-cols-3 gap-2">
              <div><Label className="text-xs">Score</Label><Input value={cruiseline.score} onChange={(e) => setCruiseline({ ...cruiseline, score: e.target.value })} placeholder="4.3" /></div>
              <div><Label className="text-xs">Out of</Label><Input value={cruiseline.scale} onChange={(e) => setCruiseline({ ...cruiseline, scale: e.target.value })} placeholder="5" /></div>
              <div><Label className="text-xs"># Reviews</Label><Input value={cruiseline.count} onChange={(e) => setCruiseline({ ...cruiseline, count: e.target.value })} placeholder="1200" /></div>
            </div>
            <div><Label className="text-xs">Source URL</Label><Input value={cruiseline.url} onChange={(e) => setCruiseline({ ...cruiseline, url: e.target.value })} placeholder="https://www.cruiseline.com/…" /></div>
          </div>
          <div className="space-y-2 border rounded-md p-3">
            <div className="text-sm font-semibold">CruiseCritic</div>
            <div className="grid grid-cols-3 gap-2">
              <div><Label className="text-xs">Score</Label><Input value={cruisecritic.score} onChange={(e) => setCruisecritic({ ...cruisecritic, score: e.target.value })} placeholder="4.0" /></div>
              <div><Label className="text-xs">Out of</Label><Input value={cruisecritic.scale} onChange={(e) => setCruisecritic({ ...cruisecritic, scale: e.target.value })} placeholder="5" /></div>
              <div><Label className="text-xs"># Reviews</Label><Input value={cruisecritic.count} onChange={(e) => setCruisecritic({ ...cruisecritic, count: e.target.value })} placeholder="850" /></div>
            </div>
            <div><Label className="text-xs">Source URL</Label><Input value={cruisecritic.url} onChange={(e) => setCruisecritic({ ...cruisecritic, url: e.target.value })} placeholder="https://www.cruisecritic.com/…" /></div>
          </div>
        </div>

        <div>
          <Label className="text-xs">Themes noticed (free text — what reviewers keep saying, good and bad)</Label>
          <Textarea rows={3} value={themes} onChange={(e) => setThemes(e.target.value)} placeholder="Long dinner waits at peak times, kids loved the water park, elevators packed at disembarkation, cabins felt tight for 4…" />
        </div>

        <Button onClick={draft} disabled={drafting || (!cruiseline.score && !cruisecritic.score)}>
          <Sparkles className="w-4 h-4 mr-1.5" />
          {drafting ? "Drafting…" : "Draft"}
        </Button>

        {candidate && (
          <div className="border-t pt-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShipDancers rating={candidate.rating} />
              <span className="text-sm font-semibold">{candidate.ratingDisplay}</span>
              <Badge variant="outline" className="text-xs">{candidate.sourceCount} source{candidate.sourceCount !== 1 ? "s" : ""}</Badge>
            </div>
            <div>
              <Label className="text-xs">Comment (main voice — edit before saving if needed)</Label>
              <Textarea rows={3} value={candidate.comment} onChange={(e) => setCandidate({ ...candidate, comment: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Salty Grump take (dry aside — always shown alongside the score)</Label>
              <Textarea rows={2} value={candidate.saltyGrumpTake} onChange={(e) => setCandidate({ ...candidate, saltyGrumpTake: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={save} disabled={saving}>
                <Save className="w-4 h-4 mr-1.5" />
                {saving ? "Saving…" : "Save as draft"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Saving does not publish. Publish from the list below once you're happy.</p>
          </div>
        )}
      </Card>

      {/* Existing ratings list */}
      <Card>
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Ratings on file</h3>
        </div>
        {admin.isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : ratings.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No ratings drafted yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {ratings.map((r) => (
              <div key={r.ship_slug} className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{r.ship_slug}</span>
                  {r.rating != null && <ShipDancers rating={r.rating} />}
                  <span className="text-sm font-mono">{r.rating_display}</span>
                  <Badge variant={r.status === "published" ? "default" : "outline"} className="text-xs">
                    {r.status === "published" ? "Published" : "Draft"}
                  </Badge>
                  <Badge variant={r.comment_status === "approved" ? "default" : "outline"} className="text-xs">
                    Copy {r.comment_status === "approved" ? "approved" : "draft"}
                  </Badge>
                  <div className="ml-auto flex gap-2">
                    {r.status === "published" ? (
                      <Button size="sm" variant="outline" onClick={() => unpublish(r.ship_slug)}>
                        <Undo2 className="w-3.5 h-3.5 mr-1" /> Revert to draft
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => publish(r.ship_slug)} disabled={publishing}>
                        <Rocket className="w-3.5 h-3.5 mr-1" /> Publish
                      </Button>
                    )}
                  </div>
                </div>
                {r.comment && <p className="text-sm text-muted-foreground">{r.comment}</p>}
                {r.salty_grump_take && <p className="text-xs italic text-muted-foreground">The Salty Grump says: {r.salty_grump_take}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
