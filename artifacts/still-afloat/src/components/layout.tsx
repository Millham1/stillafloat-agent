import React from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, ListTodo, CheckCircle2, Rss, AlertTriangle, ExternalLink } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/queue", label: "Editorial Queue", icon: ListTodo },
    { href: "/approved", label: "Approved Stories", icon: CheckCircle2 },
    { href: "/feeds", label: "Live Feeds", icon: Rss },
    { href: "/alerts", label: "Operational Alerts", icon: AlertTriangle },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="h-14 flex items-center px-6 border-b border-sidebar-border">
          <span className="font-bold text-sidebar-foreground tracking-tight">STILL AFLOAT</span>
          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-sidebar-accent text-sidebar-accent-foreground">OP</span>
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
                  className={`flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 flex-shrink-0 border-b bg-card flex items-center px-6 gap-4">
          <h1 className="text-sm font-semibold tracking-tight flex-1">Editorial Command Center</h1>
          <a
            href="/website/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            View Website
          </a>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
