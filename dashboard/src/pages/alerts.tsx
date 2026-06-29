import React from "react";
import { useGetAlertsFeed, getGetAlertsFeedQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, Info, ExternalLink } from "lucide-react";
import { EnableAlerts } from "@/components/enable-alerts";

export default function OperationalAlerts() {
  const { data, isLoading } = useGetAlertsFeed({ query: { queryKey: getGetAlertsFeedQueryKey() } });

  const alerts = data?.alerts || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Operational Alerts</h2>
        <p className="text-sm text-muted-foreground mt-1">
          High and Critical impact stories surfaced immediately.
        </p>
      </div>

      <EnableAlerts />

      {isLoading && (
        <div className="text-sm text-muted-foreground animate-pulse">Loading alerts...</div>
      )}

      <div className="space-y-4">
        {alerts.map(alert => {
          const isCritical = alert.impactLevel?.toLowerCase() === 'critical';
          
          return (
            <Card key={alert.id} className={`border-l-4 ${isCritical ? 'border-l-red-500 bg-red-500/5' : 'border-l-orange-500 bg-orange-500/5'}`}>
              <CardContent className="p-5">
                <div className="flex items-start gap-4">
                  <div className={`mt-1 flex-shrink-0 ${isCritical ? 'text-red-500' : 'text-orange-500'}`}>
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <h3 className={`text-lg font-bold leading-tight ${isCritical ? 'text-red-700 dark:text-red-400' : 'text-orange-700 dark:text-orange-400'}`}>
                        {alert.title}
                      </h3>
                    </div>
                    {alert.summary && (
                      <p className="text-sm text-foreground/80">{alert.summary}</p>
                    )}
                    {alert.travelerImpact && (
                      <div className="flex items-start gap-2 bg-background/50 p-3 rounded text-sm mt-3 border">
                        <Info className="w-4 h-4 text-muted-foreground mt-0.5" />
                        <div>
                          <span className="font-semibold block mb-1">Traveler Impact</span>
                          {alert.travelerImpact}
                        </div>
                      </div>
                    )}
                    
                    <div className="pt-2 flex gap-4 text-xs font-mono text-muted-foreground">
                      <span>ID: {alert.id}</span>
                      {alert.link && (
                        <a href={alert.link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:underline">
                          Source <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {alerts.length === 0 && (
          <div className="py-12 text-center border rounded-lg bg-card border-dashed">
            <p className="text-muted-foreground">No operational alerts active.</p>
          </div>
        )}
      </div>
    </div>
  );
}
