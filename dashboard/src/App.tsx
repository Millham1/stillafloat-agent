import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout";
import { TokenGate } from "@/components/token-gate";
import Dashboard from "@/pages/dashboard";
import EditorialQueue from "@/pages/queue";
import ApprovedStories from "@/pages/approved";
import LiveFeeds from "@/pages/feeds";
import OperationalAlerts from "@/pages/alerts";
import AffiliateManager from "@/pages/affiliate";
import FavoritesManager from "@/pages/favorites";
import CommentaryManager from "@/pages/commentary";
import Subscribers from "@/pages/subscribers";
import Newsletter from "@/pages/newsletter";
import Finance from "@/pages/finance";
import Subscriptions from "@/pages/subscriptions";
import Overview from "@/pages/overview";
import Today from "@/pages/today";
import StormAlerts from "@/pages/storm-alerts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/today" component={Today} />
        <Route path="/editorial" component={Dashboard} />
        <Route path="/queue" component={EditorialQueue} />
        <Route path="/approved" component={ApprovedStories} />
        <Route path="/feeds" component={LiveFeeds} />
        <Route path="/alerts" component={OperationalAlerts} />
        <Route path="/storm-alerts" component={StormAlerts} />
        <Route path="/affiliate"   component={AffiliateManager} />
        <Route path="/favorites"   component={FavoritesManager} />
        <Route path="/commentary"  component={CommentaryManager} />
        <Route path="/subscribers" component={Subscribers} />
        <Route path="/newsletter"  component={Newsletter} />
        <Route path="/finance"       component={Finance} />
        <Route path="/subscriptions" component={Subscriptions} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TokenGate>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TokenGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
