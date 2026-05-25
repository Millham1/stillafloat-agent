import React, { useState } from "react";
import { 
  useGetHomepageFeed, 
  useGetNewsFeed, 
  useGetAlertsFeed, 
  useGetWeatherAlerts,
  getGetHomepageFeedQueryKey,
  getGetNewsFeedQueryKey,
  getGetAlertsFeedQueryKey,
  getGetWeatherAlertsQueryKey
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";

export default function LiveFeeds() {
  return (
    <div className="max-w-6xl mx-auto space-y-6 flex flex-col h-[calc(100vh-8rem)]">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Data Feeds</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Raw JSON outputs consumed by external systems.
        </p>
      </div>

      <Tabs defaultValue="homepage" className="flex-1 flex flex-col min-h-0">
        <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent mb-4">
          <TabsTrigger value="homepage" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent">Homepage Feed</TabsTrigger>
          <TabsTrigger value="news" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent">News Index</TabsTrigger>
          <TabsTrigger value="alerts" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent">Alerts Feed</TabsTrigger>
          <TabsTrigger value="weather" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent">Weather</TabsTrigger>
        </TabsList>

        <div className="flex-1 min-h-0 relative">
          <TabsContent value="homepage" className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
            <FeedViewer useHook={useGetHomepageFeed} queryKey={getGetHomepageFeedQueryKey()} />
          </TabsContent>
          <TabsContent value="news" className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
            <FeedViewer useHook={useGetNewsFeed} queryKey={getGetNewsFeedQueryKey()} />
          </TabsContent>
          <TabsContent value="alerts" className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
            <FeedViewer useHook={useGetAlertsFeed} queryKey={getGetAlertsFeedQueryKey()} />
          </TabsContent>
          <TabsContent value="weather" className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
            <FeedViewer useHook={useGetWeatherAlerts} queryKey={getGetWeatherAlertsQueryKey()} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function FeedViewer({ useHook, queryKey }: { useHook: any, queryKey: any }) {
  const { data, isLoading, error } = useHook({ query: { queryKey } });

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground border rounded-md h-full bg-muted/10 animate-pulse">Loading feed data...</div>;
  if (error) return <div className="p-4 text-sm text-destructive border border-destructive/20 rounded-md bg-destructive/10 h-full overflow-auto"><pre>{JSON.stringify(error, null, 2)}</pre></div>;

  return (
    <Card className="h-full border bg-[#1E1E1E] text-[#D4D4D4] rounded-md overflow-hidden flex flex-col">
      <div className="bg-[#2D2D2D] px-4 py-2 border-b border-[#3E3E3E] text-xs font-mono flex justify-between items-center text-muted-foreground flex-shrink-0">
        <span>application/json</span>
        <span>{JSON.stringify(data).length} bytes</span>
      </div>
      <CardContent className="p-0 overflow-auto flex-1">
        <pre className="p-4 text-sm font-mono leading-relaxed whitespace-pre-wrap">
          {JSON.stringify(data, null, 2)}
        </pre>
      </CardContent>
    </Card>
  );
}
