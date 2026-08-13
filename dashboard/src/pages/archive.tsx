import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Archive, Search, ExternalLink, ChevronDown, ChevronUp, Star } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

// Story Archive (task 669ea94b) — browse + search every story ever approved,
// including the ones the newsagent's daily 21-day sweep has aged out of the
// live feed. Search covers EN + ES title/summary/impact text; the date range
// filters on approvedAt. Each result links to its permanent public
// /news/<slug>.html page (those pages persist forever — SEO asset).

type ArchiveStory = {
  id: string;
  slug: string;
  url: string;
  urlEs: string;
  title: string;
  title_es: string;
  summary: string;
  summary_es: string;
  category: string;
  impactLevel: string;
  source: string;
  link: string;
  approvedAt: string | null;
  archivedAt: string | null;
  featured: boolean;
  status: "archived" | "live";
};

type ArchiveResponse = {
  success: boolean;
  total: number;
  offset: number;
  limit: number;
  stories: ArchiveStory[];
};

type DetailResponse = ArchiveStory & {
  success: boolean;
  story: Record<string, unknown>;
};

const PAGE_SIZE = 25;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export default function StoryArchive() {
  // Draft inputs vs the submitted search actually sent to the API.
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState({ q: "", from: "", to: "", offset: 0 });

  const { data, isLoading, isFetching } = useQuery<ArchiveResponse>({
    queryKey: ["news-archive", search],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search.q) params.set("q", search.q);
      if (search.from) params.set("from", search.from);
      if (search.to) params.set("to", search.to);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(search.offset));
      return fetch(`/api/news-archive?${params}`, { headers: { ...authHeaders() } }).then((r) => r.json());
    },
    staleTime: 60_000,
  });

  const stories = data?.stories ?? [];
  const total = data?.total ?? 0;
  const page = Math.floor(search.offset / PAGE_SIZE) + 1;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setSearch({ q: q.trim(), from, to, offset: 0 });
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Archive className="h-6 w-6 text-primary" />
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Story Archive</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Every approved story, including those aged out of the live feed after 21 days.
            Their public pages stay online forever.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs font-medium text-muted-foreground">Search (EN + ES)</label>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. norovirus, Carnival, huracán…"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">From</label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">To</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
        </div>
        <Button type="submit" disabled={isFetching}>
          <Search className="w-4 h-4 mr-1" /> Search
        </Button>
      </form>

      {isLoading && <p className="text-sm text-muted-foreground animate-pulse">Loading archive…</p>}

      {!isLoading && (
        <p className="text-sm text-muted-foreground">
          {total} {total === 1 ? "story" : "stories"} found
          {pages > 1 && ` · page ${page} of ${pages}`}
        </p>
      )}

      <div className="space-y-3">
        {stories.map((story) => (
          <ArchiveStoryCard key={story.id} story={story} />
        ))}
        {!isLoading && stories.length === 0 && (
          <div className="py-12 text-center border rounded-lg bg-card border-dashed">
            <p className="text-muted-foreground">No stories match this search.</p>
          </div>
        )}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={search.offset === 0 || isFetching}
            onClick={() => setSearch((s) => ({ ...s, offset: Math.max(s.offset - PAGE_SIZE, 0) }))}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">{page} / {pages}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={search.offset + PAGE_SIZE >= total || isFetching}
            onClick={() => setSearch((s) => ({ ...s, offset: s.offset + PAGE_SIZE }))}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function ArchiveStoryCard({ story }: { story: ArchiveStory }) {
  const [open, setOpen] = useState(false);

  // Full record (traveler impact, Mark's take, ES twins) fetched on expand only.
  const { data: detail, isLoading: detailLoading } = useQuery<DetailResponse>({
    queryKey: ["news-archive-story", story.id],
    queryFn: () =>
      fetch(`/api/news-archive/story?id=${encodeURIComponent(story.id)}`, {
        headers: { ...authHeaders() },
      }).then((r) => r.json()),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const full = (detail?.story ?? {}) as Record<string, string>;

  return (
    <Card>
      <CardContent className="p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={story.status === "archived" ? "secondary" : "default"}
            className="text-xs"
          >
            {story.status === "archived" ? "Archived" : "Live"}
          </Badge>
          {story.featured && (
            <Badge variant="default" className="bg-primary gap-1 text-xs">
              <Star className="w-3 h-3" /> Featured
            </Badge>
          )}
          {story.category && (
            <Badge variant="outline" className="font-mono text-xs">{story.category}</Badge>
          )}
          {story.impactLevel && (
            <Badge variant="secondary" className="text-xs">{story.impactLevel}</Badge>
          )}
          <span className="ml-auto text-xs text-muted-foreground font-mono">
            {fmtDate(story.approvedAt)}
          </span>
        </div>

        <div>
          <h3 className="text-base font-semibold leading-tight">{story.title}</h3>
          {story.title_es && (
            <p className="text-xs text-muted-foreground italic mt-0.5">ES: {story.title_es}</p>
          )}
        </div>

        <p className={`text-sm text-muted-foreground ${open ? "" : "line-clamp-2"}`}>
          {story.summary}
        </p>

        {open && (
          <div className="space-y-3 text-sm border-t pt-3">
            {detailLoading && <p className="text-muted-foreground animate-pulse">Loading details…</p>}
            {full["travelerImpact"] && (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">What this means for you</p>
                <p>{full["travelerImpact"]}</p>
              </div>
            )}
            {(full["editorialReasoning"] || full["reasoning"]) && (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Mark's take</p>
                <p className="italic">{full["editorialReasoning"] || full["reasoning"]}</p>
              </div>
            )}
            {full["summary_es"] && (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Resumen (ES)</p>
                <p>{full["summary_es"]}</p>
              </div>
            )}
            {story.archivedAt && (
              <p className="text-xs text-muted-foreground">
                Archived {fmtDate(story.archivedAt)}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 font-medium text-primary hover:underline"
          >
            {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {open ? "Hide details" : "Details"}
          </button>
          <a
            href={story.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            Public page <ExternalLink className="w-3 h-3" />
          </a>
          {story.urlEs && (
            <a
              href={story.urlEs}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              Página ES <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {story.link && (
            <a
              href={story.link}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              Original source <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
