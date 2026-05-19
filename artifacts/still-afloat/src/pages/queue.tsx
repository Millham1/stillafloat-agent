import React, { useState } from "react";
import { useGetEditorialQueue, getGetEditorialQueueQueryKey, getGetHomepageFeedQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink, Check, X, Clock, Pin, AlertTriangle, Star } from "lucide-react";

const getImpactColor = (impact?: string | null) => {
  switch (impact?.toLowerCase()) {
    case 'critical': return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-900';
    case 'high': return 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-900';
    case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-900';
    case 'low': return 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-900';
    default: return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700';
  }
};

const TIER_LABELS: Record<number, { label: string; className: string }> = {
  1: { label: 'T1 · Cruise', className: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-900' },
  2: { label: 'T2 · Operations', className: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-900' },
  3: { label: 'T3 · Mainstream', className: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900' },
  4: { label: 'T4 · Lifestyle', className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-900' },
};

const DECISION_STATUSES = new Set(['approved', 'featured', 'rejected', 'held', 'deferred']);

const STATUS_META: Record<string, { label: string; icon: React.ReactNode; badgeClass: string; borderClass: string }> = {
  featured: {
    label: 'Featured',
    icon: <Star className="w-3.5 h-3.5" />,
    badgeClass: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/40 dark:text-purple-200 dark:border-purple-700',
    borderClass: 'border-l-purple-500',
  },
  approved: {
    label: 'Approved',
    icon: <Check className="w-3.5 h-3.5" />,
    badgeClass: 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/40 dark:text-green-200 dark:border-green-700',
    borderClass: 'border-l-green-500',
  },
  rejected: {
    label: 'Rejected',
    icon: <X className="w-3.5 h-3.5" />,
    badgeClass: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/40 dark:text-red-200 dark:border-red-700',
    borderClass: 'border-l-red-400',
  },
  held: {
    label: 'On Hold',
    icon: <Clock className="w-3.5 h-3.5" />,
    badgeClass: 'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600',
    borderClass: 'border-l-gray-400',
  },
  deferred: {
    label: 'On Hold',
    icon: <Clock className="w-3.5 h-3.5" />,
    badgeClass: 'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600',
    borderClass: 'border-l-gray-400',
  },
};

type Story = {
  id: string;
  title?: string | null;
  tier?: number | null;
  category?: string | null;
  impactLevel?: string | null;
  travelerImpact?: string | null;
  summary?: string | null;
  reasoning?: string | null;
  source?: string | null;
  link?: string | null;
  status?: string | null;
  decidedAt?: string | null;
};

export default function EditorialQueue() {
  const { data, isLoading } = useGetEditorialQueue({ query: { queryKey: getGetEditorialQueueQueryKey() } });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [processing, setProcessing] = useState<Record<string, string>>({});
  const [showReviewed, setShowReviewed] = useState(false);

  const handleAction = async (id: string, action: 'approve' | 'reject' | 'feature' | 'hold') => {
    setProcessing(prev => ({ ...prev, [id]: action }));
    const token = import.meta.env.VITE_AGENT_TOKEN || '';

    try {
      const res = await fetch(`/api/agent-action?action=${action}&id=${id}&token=${token}`);
      const json = await res.json();

      if (res.ok && json.success) {
        toast({
          title: action === 'feature' ? 'Story Featured' : action === 'approve' ? 'Story Approved' : action === 'reject' ? 'Story Rejected' : 'Story Held',
          description: action === 'feature' ? 'Will appear on the homepage.' : action === 'approve' ? 'Added to the news feed.' : action === 'reject' ? 'Removed from publishing.' : 'Saved for later review.',
        });
        queryClient.invalidateQueries({ queryKey: getGetEditorialQueueQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetHomepageFeedQueryKey() });
      } else {
        throw new Error(json.error || "Failed to process action");
      }
    } catch (err: unknown) {
      toast({
        variant: "destructive",
        title: "Action Failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setProcessing(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  if (isLoading) return <div className="text-sm text-muted-foreground animate-pulse">Loading queue...</div>;

  const allStories = (data?.stories || []) as Story[];
  const undecided = allStories.filter(s => !s.status || !DECISION_STATUSES.has(s.status));
  const reviewed = allStories.filter(s => s.status && DECISION_STATUSES.has(s.status));

  const TIER_META = [
    { tier: 1, label: 'T1 · Cruise', target: '35–55%', className: 'bg-blue-100 text-blue-800 border-blue-200', barColor: 'bg-blue-400' },
    { tier: 2, label: 'T2 · Operations', target: '0–20%', className: 'bg-purple-100 text-purple-800 border-purple-200', barColor: 'bg-purple-400' },
    { tier: 3, label: 'T3 · Mainstream', target: '0–20%', className: 'bg-amber-100 text-amber-800 border-amber-200', barColor: 'bg-amber-400' },
    { tier: 4, label: 'T4 · Lifestyle', target: '15–30%', className: 'bg-green-100 text-green-800 border-green-200', barColor: 'bg-green-400' },
  ];

  const tierCounts = TIER_META.map(({ tier }) => ({
    tier,
    count: undecided.filter(s => s.tier === tier).length,
  }));

  const renderStoryCard = (story: Story, isDecided: boolean) => {
    const statusMeta = story.status ? STATUS_META[story.status] : null;
    const borderClass = statusMeta?.borderClass || (isDecided ? 'border-l-gray-300' : 'border-l-primary/20');

    return (
      <Card
        key={story.id}
        className={`overflow-hidden border-l-4 ${borderClass} transition-colors ${isDecided ? 'opacity-60 hover:opacity-90' : 'hover:border-l-primary'}`}
      >
        <CardContent className="p-0">
          <div className="flex flex-col md:flex-row">
            <div className="flex-1 p-5 space-y-4">
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {statusMeta && (
                    <Badge variant="outline" className={`flex items-center gap-1 text-xs font-semibold px-2 py-0.5 ${statusMeta.badgeClass}`}>
                      {statusMeta.icon}
                      {statusMeta.label}
                    </Badge>
                  )}
                  <Badge variant="outline" className={getImpactColor(story.impactLevel)}>
                    {story.impactLevel || 'Unknown'} Impact
                  </Badge>
                  {story.category && (
                    <Badge variant="secondary" className="font-mono text-xs">
                      {story.category}
                    </Badge>
                  )}
                  {story.tier && TIER_LABELS[story.tier] && (
                    <Badge variant="outline" className={`text-xs font-bold ${TIER_LABELS[story.tier].className}`}>
                      {TIER_LABELS[story.tier].label}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto truncate max-w-[200px]">
                    {story.source || story.id}
                  </span>
                </div>
                <h3 className="text-lg font-semibold leading-tight">{story.title}</h3>
              </div>

              {story.summary && (
                <p className="text-sm text-muted-foreground leading-relaxed">{story.summary}</p>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm bg-muted/30 p-3 rounded-md border">
                <div>
                  <span className="font-semibold text-xs uppercase tracking-wider text-muted-foreground block mb-1">Agent Reasoning</span>
                  <p>{story.reasoning || 'No reasoning provided.'}</p>
                </div>
                <div>
                  <span className="font-semibold text-xs uppercase tracking-wider text-muted-foreground block mb-1">Traveler Impact</span>
                  <p>{story.travelerImpact || 'None identified.'}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs">
                {story.link && (
                  <a href={story.link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                    <ExternalLink className="w-3 h-3" /> Source Article
                  </a>
                )}
                {story.decidedAt && (
                  <span className="text-muted-foreground">
                    Decided {new Date(story.decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>

            <div className={`p-4 md:w-48 flex flex-row md:flex-col gap-2 justify-center border-t md:border-t-0 md:border-l ${isDecided ? 'bg-muted/5' : 'bg-muted/10'}`}>
              {isDecided && statusMeta && (
                <p className="text-xs text-muted-foreground text-center mb-1 hidden md:block">Change decision:</p>
              )}
              <Button
                variant="outline"
                size={isDecided ? "sm" : "default"}
                className={`w-full justify-start gap-2 border-green-300 text-green-700 hover:bg-green-50 hover:border-green-400 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-950/40 ${story.status === 'approved' ? 'ring-2 ring-green-400 bg-green-50 dark:bg-green-950/30' : ''}`}
                onClick={() => handleAction(story.id, 'approve')}
                disabled={!!processing[story.id]}
              >
                <Check className="w-4 h-4" />
                {processing[story.id] === 'approve' ? '…' : story.status === 'approved' ? 'Approved ✓' : 'Approve'}
              </Button>
              <Button
                variant="outline"
                size={isDecided ? "sm" : "default"}
                className={`w-full justify-start gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30 ${story.status === 'rejected' ? 'ring-2 ring-red-400 bg-red-50 dark:bg-red-950/30' : ''}`}
                onClick={() => handleAction(story.id, 'reject')}
                disabled={!!processing[story.id]}
              >
                <X className="w-4 h-4" />
                {processing[story.id] === 'reject' ? '…' : story.status === 'rejected' ? 'Rejected ✓' : 'Reject'}
              </Button>
              <Button
                variant="outline"
                size={isDecided ? "sm" : "default"}
                className={`w-full justify-start gap-2 border-purple-200 text-purple-600 hover:bg-purple-50 hover:border-purple-300 dark:border-purple-900 dark:text-purple-400 dark:hover:bg-purple-950/30 ${story.status === 'featured' ? 'ring-2 ring-purple-400 bg-purple-50 dark:bg-purple-950/30' : ''}`}
                onClick={() => handleAction(story.id, 'feature')}
                disabled={!!processing[story.id]}
              >
                <Pin className="w-4 h-4" />
                {processing[story.id] === 'feature' ? '…' : story.status === 'featured' ? 'Featured ✓' : 'Feature'}
              </Button>
              {!isDecided && (
                <Button
                  variant="outline"
                  className={`w-full justify-start gap-2 border-input text-muted-foreground hover:text-foreground ${story.status === 'held' || story.status === 'deferred' ? 'ring-2 ring-gray-400 bg-muted' : ''}`}
                  onClick={() => handleAction(story.id, 'hold')}
                  disabled={!!processing[story.id]}
                >
                  <Clock className="w-4 h-4" />
                  {processing[story.id] === 'hold' ? '…' : 'Hold'}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Editorial Queue</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {undecided.length} pending · {reviewed.length} reviewed
          {allStories.length > 0 && ` · ${allStories.length} total this run`}
        </p>
      </div>

      {allStories.length > 0 && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tier Coverage — Pending Stories</p>
          <div className="grid grid-cols-4 gap-3">
            {TIER_META.map(({ tier, label, target, className, barColor }) => {
              const count = tierCounts.find(t => t.tier === tier)?.count ?? 0;
              const pct = undecided.length > 0 ? Math.round((count / undecided.length) * 100) : 0;
              return (
                <div key={tier} className={`rounded-md border px-3 py-2 text-xs ${className} ${count === 0 ? 'opacity-40' : ''}`}>
                  <div className="font-bold mb-1">{label}</div>
                  <div className="text-lg font-mono font-bold leading-none">{count}</div>
                  <div className="mt-1.5 h-1 rounded-full bg-black/10">
                    <div className={`h-1 rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 opacity-70">target {target}</div>
                </div>
              );
            })}
          </div>
          {undecided.length === 0 && reviewed.length > 0 && (
            <div className="flex items-start gap-2 text-xs rounded-md border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900 px-3 py-2 text-green-800 dark:text-green-300">
              <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>All {reviewed.length} stories reviewed. Trigger a new scan to get fresh candidates.</span>
            </div>
          )}
          {undecided.length > 0 && tierCounts.filter(({ count }) => count === 0).length > 0 && (
            <div className="flex items-start gap-2 text-xs rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-3 py-2 text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                <strong>Low coverage:</strong>{' '}
                {tierCounts.filter(({ count }) => count === 0).map(({ tier }) => TIER_META[tier - 1].label).join(', ')} has no stories pending.
              </span>
            </div>
          )}
        </div>
      )}

      <div className="space-y-4">
        {undecided.map(story => renderStoryCard(story, false))}

        {undecided.length === 0 && reviewed.length === 0 && (
          <div className="py-12 text-center border rounded-lg bg-card border-dashed">
            <p className="text-muted-foreground">The queue is currently empty. Trigger a scan to get new stories.</p>
          </div>
        )}

        {reviewed.length > 0 && (
          <div className="pt-2">
            <button
              onClick={() => setShowReviewed(v => !v)}
              className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-lg border border-border bg-muted/40 hover:bg-muted/70 transition-colors text-sm font-medium mb-4"
            >
              <span className="text-muted-foreground">{showReviewed ? '▾' : '▸'}</span>
              <span className="flex items-center gap-1.5">
                {(() => {
                  const approved = reviewed.filter(s => s.status === 'approved').length;
                  const featured = reviewed.filter(s => s.status === 'featured').length;
                  const rejected = reviewed.filter(s => s.status === 'rejected').length;
                  const held     = reviewed.filter(s => s.status === 'held' || s.status === 'deferred').length;
                  const parts: React.ReactNode[] = [];
                  if (approved) parts.push(<span key="a" className="text-green-600 dark:text-green-400 font-semibold">{approved} approved</span>);
                  if (featured) parts.push(<span key="f" className="text-purple-600 dark:text-purple-400 font-semibold">{featured} featured</span>);
                  if (rejected) parts.push(<span key="r" className="text-red-500 dark:text-red-400 font-semibold">{rejected} rejected</span>);
                  if (held)     parts.push(<span key="h" className="text-gray-500 font-semibold">{held} held</span>);
                  return parts.flatMap((p, i) => i < parts.length - 1 ? [p, <span key={`sep${i}`} className="text-muted-foreground/40">·</span>] : [p]);
                })()}
              </span>
              <span className="text-muted-foreground text-xs">{showReviewed ? '— click to hide' : '— click to review'}</span>
            </button>

            {showReviewed && (
              <div className="space-y-3">
                {reviewed.map(story => renderStoryCard(story, true))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
