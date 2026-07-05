import React from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, ListTodo, CheckCircle2, Rss, AlertTriangle, ExternalLink, RefreshCw, ShoppingBag, Heart, MessageSquare, Users, Mail, Wallet, CreditCard, Gauge, Sunrise, Menu, X, CloudLightning } from "lucide-react";
import { useScanNews, getGetSystemStatusQueryKey, getGetEditorialQueueQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const scanMutation = useScanNews();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => { setSidebarOpen(false); }, [location]);

  const handleScan = () => {
    scanMutation.mutate(undefined, {
      onSuccess: (data) => {
        toast({
          title: "Scan Complete",
          description: `Curated ${data.curatedStories} new candidates.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetSystemStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetEditorialQueueQueryKey() });
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: "Scan Failed",
          description: (err as Error)?.message || "Failed to trigger news scan",
        });
      },
    });
  };

  const navItems = [
    { href: "/today", label: "Today", icon: Sunrise },
    { href: "/", label: "Business Health", icon: Gauge },
    { href: "/editorial", label: "Editorial", icon: LayoutDashboard },
    { href: "/queue", label: "Editorial Queue", icon: ListTodo },
    { href: "/approved", label: "Approved Stories", icon: CheckCircle2 },
    { href: "/feeds", label: "Live Feeds", icon: Rss },
    { href: "/alerts", label: "Operational Alerts", icon: AlertTriangle },
    { href: "/storm-alerts", label: "Storm Alerts", icon: CloudLightning },
    { href: "/affiliate",    label: "Affiliate Manager", icon: ShoppingBag },
    { href: "/favorites",    label: "Favorites",         icon: Heart },
    { href: "/commentary",   label: "Commentary",        icon: MessageSquare },
    { href: "/subscribers",  label: "Subscribers",       icon: Users },
    { href: "/newsletter",   label: "Send Newsletter",   icon: Mail },
    { href: "/finance",      label: "Finance",           icon: Wallet },
    { href: "/subscriptions", label: "Subscriptions",    icon: CreditCard },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Backdrop — mobile only, when the drawer is open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — static on md+, slide-in drawer on mobile */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col transform transition-transform duration-200 md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-14 flex items-center px-6 border-b border-sidebar-border">
          <span className="font-bold text-sidebar-foreground tracking-tight">STILL AFLOAT</span>
          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-sidebar-accent text-sidebar-accent-foreground">OP</span>
          <button
            className="ml-auto md:hidden text-sidebar-foreground/70 hover:text-sidebar-foreground"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-4">
          <nav className="space-y-1 px-3">
            {navItems.map((item) => {
              const active = location === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 flex-shrink-0 border-b bg-card flex items-center px-4 md:px-6 gap-3 md:gap-4">
          <button
            className="md:hidden text-muted-foreground hover:text-foreground"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-sm font-semibold tracking-tight flex-1 truncate">Editorial Command Center</h1>
          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            View Website
          </a>
          <button
            onClick={handleScan}
            disabled={scanMutation.isPending}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors font-medium flex-shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanMutation.isPending ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">{scanMutation.isPending ? "Scanning…" : "Trigger Fast Scan"}</span>
          </button>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
