import React, { useState } from "react";
import { useGetSystemStatus, getGetSystemStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Radio, Archive, LayoutTemplate, AlertTriangle, Youtube, RefreshCw, Star } from "lucide-react";

interface YTVideo {
  id: string;
  title: string;
  published: string;
  thumbnail: string;
  url: string;
}

interface YouTubeScanResult {
  success: boolean;
  scannedAt: string;
  videos: YTVideo[];
  featuredId?: string;
  error?: string;
}

function YouTubeCard() {
  const [scanning, setScanning] = useState(false);
  const [featuring, setFeaturing] = useState<string | null>(null);
  const [result, setResult] = useState<YouTubeScanResult | null>(null);
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/youtube-scan");
      const data = await res.json() as YouTubeScanResult;
      setResult(data);
      setFeaturedId(data.featuredId ?? data.videos?.[0]?.id ?? null);
      if (!data.success) setError(data.error ?? "Scan failed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const featureVideo = async (videoId: string) => {
    setFeaturing(videoId);
    try {
      const res = await fetch("/api/youtube-feature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
      const data = await res.json() as { success: boolean };
      if (data.success) setFeaturedId(videoId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFeaturing(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Youtube className="w-5 h-5 text-red-500" />
          YouTube Channel
        </CardTitle>
        <div className="flex items-center gap-2">
          <a
            href="https://www.youtube.com/@StillAfloatcruising2026"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Open Channel ↗
          </a>
          <Button size="sm" variant="outline" onClick={scan} disabled={scanning}>
            <RefreshCw className={`w-4 h-4 mr-2 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "Scanning…" : "Scan for New Videos"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded p-3 mb-4">
            {error}
          </div>
        )}
        {!result && !error && (
          <p className="text-sm text-muted-foreground">
            Click <strong>Scan for New Videos</strong> to fetch the latest from your YouTube channel and choose which video is featured on the homepage.
          </p>
        )}
        {result?.videos && result.videos.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground mb-4">
              Found {result.videos.length} video{result.videos.length !== 1 ? "s" : ""} — last scanned {new Date(result.scannedAt).toLocaleString()}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {result.videos.map((v) => {
                const isFeatured = featuredId === v.id;
                return (
                  <div
                    key={v.id}
                    className={`relative rounded-lg overflow-hidden border transition-all ${isFeatured ? "border-red-500 ring-2 ring-red-500/40" : "border-border"}`}
                  >
                    <a href={v.url} target="_blank" rel="noopener noreferrer">
                      <img
                        src={v.thumbnail}
                        alt={v.title}
                        className="w-full aspect-video object-cover hover:opacity-90 transition-opacity"
                      />
                    </a>
                    <div className="p-2">
                      <p className="text-xs font-medium line-clamp-2 mb-2">{v.title}</p>
                      <p className="text-xs text-muted-foreground mb-2">
                        {new Date(v.published).toLocaleDateString()}
                      </p>
                      <Button
                        size="sm"
                        variant={isFeatured ? "default" : "outline"}
                        className="w-full text-xs"
                        disabled={isFeatured || featuring === v.id}
                        onClick={() => featureVideo(v.id)}
                      >
                        <Star className={`w-3 h-3 mr-1 ${isFeatured ? "fill-current" : ""}`} />
                        {isFeatured ? "Featured on Homepage" : featuring === v.id ? "Featuring…" : "Feature on Homepage"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {result?.videos?.length === 0 && (
          <p className="text-sm text-muted-foreground">No videos found on the channel yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: status, isLoading } = useGetSystemStatus({ query: { queryKey: getGetSystemStatusQueryKey() } });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground animate-pulse">Loading telemetry...</div>;
  }

  if (!status) {
    return <div className="text-sm text-destructive">Failed to load system status.</div>;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">System Status</h2>
        <p className="text-sm text-muted-foreground mt-1">Real-time overview of curation pipeline and publishing state.</p>
      </div>

      {status.pipeline?.degradedMode && (
        <div className="bg-destructive/10 text-destructive border border-destructive/20 p-4 rounded-md text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          System operating in degraded mode: {status.pipeline.degradedReason}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Candidates</CardTitle>
            <Radio className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{status.publishing?.candidateStories || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Awaiting editorial review</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Approved Stories</CardTitle>
            <Archive className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{status.publishing?.approvedStories || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Total published archive</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Homepage Stories</CardTitle>
            <LayoutTemplate className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{status.publishing?.homepageStories || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Currently featured</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Subsystems Health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatusIndicator label="OpenAI Curation" active={!!status.systems?.openaiConfigured} />
            <StatusIndicator label="GNews Ingestion" active={!!status.systems?.gnewsConfigured} />
            <StatusIndicator label="Weather Alerts" active={!!status.systems?.weatherConfigured} />
            <StatusIndicator label="Agent Approval" active={!!status.systems?.approvalConfigured} />
          </div>
        </CardContent>
      </Card>

      <YouTubeCard />
    </div>
  );
}

function StatusIndicator({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex items-center gap-2 p-3 border rounded-md bg-card">
      <div className={`w-2 h-2 rounded-full ${active ? "bg-green-500" : "bg-red-500"}`} />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}
