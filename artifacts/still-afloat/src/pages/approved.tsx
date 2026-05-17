import React from "react";
import { useGetHomepageFeed, getGetHomepageFeedQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Star } from "lucide-react";

export default function ApprovedStories() {
  const { data, isLoading } = useGetHomepageFeed({ query: { queryKey: getGetHomepageFeedQueryKey() } });

  if (isLoading) return <div className="text-sm text-muted-foreground animate-pulse">Loading approved stories...</div>;

  const stories = data?.stories || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Approved & Published</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {data?.count || 0} stories currently live on the homepage feed.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {stories.map(story => (
          <Card key={story.id} className={`overflow-hidden ${story.featured ? 'border-primary ring-1 ring-primary/20' : ''}`}>
            <CardContent className="p-5 flex flex-col h-full space-y-4">
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  {story.featured && (
                    <Badge variant="default" className="bg-primary gap-1">
                      <Star className="w-3 h-3" /> Featured
                    </Badge>
                  )}
                  {story.category && (
                    <Badge variant="outline" className="font-mono text-xs">
                      {story.category}
                    </Badge>
                  )}
                </div>
                <h3 className="text-lg font-semibold leading-tight mb-2">{story.title}</h3>
                <p className="text-sm text-muted-foreground line-clamp-3">{story.summary}</p>
              </div>
              
              <div className="mt-auto pt-4 border-t flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-mono">
                  {story.approvedAt ? new Date(story.approvedAt).toLocaleDateString() : 'Unknown date'}
                </span>
                {story.link && (
                  <a href={story.link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-foreground transition-colors">
                    Source <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
        {stories.length === 0 && (
          <div className="col-span-full py-12 text-center border rounded-lg bg-card border-dashed">
            <p className="text-muted-foreground">No approved stories available.</p>
          </div>
        )}
      </div>
    </div>
  );
}
