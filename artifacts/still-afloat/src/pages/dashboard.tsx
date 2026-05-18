import React from "react";
import { useGetSystemStatus, getGetSystemStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Radio, Archive, LayoutTemplate, AlertTriangle } from "lucide-react";

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
