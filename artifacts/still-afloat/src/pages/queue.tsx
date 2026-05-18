import React, { useState } from "react";
import { useGetEditorialQueue, getGetEditorialQueueQueryKey, getGetHomepageFeedQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink, Check, X, Clock, Pin } from "lucide-react";

const getImpactColor = (impact?: string | null) => {
  switch (impact?.toLowerCase()) {
    case 'critical': return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-900';
    case 'high': return 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-900';
    case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-900';
    case 'low': return 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-900';
    default: return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700';
  }
};

export default function EditorialQueue() {
  const { data, isLoading } = useGetEditorialQueue({ query: { queryKey: getGetEditorialQueueQueryKey() } });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [processing, setProcessing] = useState<Record<string, string>>({});

  const handleAction = async (id: string, action: 'approve' | 'reject' | 'feature' | 'hold') => {
    setProcessing(prev => ({ ...prev, [id]: action }));
    const token = import.meta.env.VITE_AGENT_TOKEN || '';
    
    try {
      const res = await fetch(`/api/agent-action?action=${action}&id=${id}&token=${token}`);
      const json = await res.json();
      
      if (res.ok && json.success) {
        toast({
          title: `Story ${action}d`,
          description: "Queue updated successfully.",
        });
        queryClient.invalidateQueries({ queryKey: getGetEditorialQueueQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetHomepageFeedQueryKey() });
      } else {
        throw new Error(json.error || "Failed to process action");
      }
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Action Failed",
        description: err.message,
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

  const stories = data?.stories || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Editorial Queue</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {data?.count || 0} candidate stories pending review. Ranked by agent priority.
        </p>
      </div>

      <div className="space-y-4">
        {stories.map(story => (
          <Card key={story.id} className="overflow-hidden border-l-4 border-l-primary/20 hover:border-l-primary transition-colors">
            <CardContent className="p-0">
              <div className="flex flex-col md:flex-row">
                <div className="flex-1 p-5 space-y-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <Badge variant="outline" className={getImpactColor(story.impactLevel)}>
                        {story.impactLevel || 'Unknown'} Impact
                      </Badge>
                      {story.category && (
                        <Badge variant="secondary" className="font-mono text-xs">
                          {story.category}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {story.id}
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
                  </div>
                </div>
                
                <div className="bg-muted/10 p-4 md:w-48 flex flex-row md:flex-col gap-2 justify-center border-t md:border-t-0 md:border-l">
                  <Button 
                    variant="default" 
                    className="w-full justify-start gap-2 bg-green-600 hover:bg-green-700 text-white"
                    onClick={() => handleAction(story.id, 'approve')}
                    disabled={!!processing[story.id]}
                  >
                    <Check className="w-4 h-4" /> 
                    {processing[story.id] === 'approve' ? '...' : 'Approve'}
                  </Button>
                  <Button 
                    variant="outline" 
                    className="w-full justify-start gap-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                    onClick={() => handleAction(story.id, 'reject')}
                    disabled={!!processing[story.id]}
                  >
                    <X className="w-4 h-4" /> 
                    {processing[story.id] === 'reject' ? '...' : 'Reject'}
                  </Button>
                  <Button 
                    variant="outline" 
                    className="w-full justify-start gap-2 text-purple-600 hover:text-purple-700 hover:bg-purple-50 dark:hover:bg-purple-950/30"
                    onClick={() => handleAction(story.id, 'feature')}
                    disabled={!!processing[story.id]}
                  >
                    <Pin className="w-4 h-4" /> 
                    {processing[story.id] === 'feature' ? '...' : 'Feature'}
                  </Button>
                  <Button 
                    variant="ghost" 
                    className="w-full justify-start gap-2 text-muted-foreground"
                    onClick={() => handleAction(story.id, 'hold')}
                    disabled={!!processing[story.id]}
                  >
                    <Clock className="w-4 h-4" /> 
                    {processing[story.id] === 'hold' ? '...' : 'Hold'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {stories.length === 0 && (
          <div className="py-12 text-center border rounded-lg bg-card border-dashed">
            <p className="text-muted-foreground">The queue is currently empty.</p>
          </div>
        )}
      </div>
    </div>
  );
}
