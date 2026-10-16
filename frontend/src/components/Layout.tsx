import { useQueryClient } from "@tanstack/react-query";
import {
  ClipboardCheck,
  FolderGit2,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Monitor,
  Moon,
  PauseCircle,
  Settings as SettingsIcon,
  Sun,
  Trophy,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useFeatures, useUnread } from "../api/queries";
import { cn } from "../lib/format";
import { ActiveCallDock, ActiveCallProvider } from "./ActiveCall";
import { Loading } from "./ui";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  end?: boolean;
}

function Logo({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-1">
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white shadow-sm"
        style={{ background: "linear-gradient(135deg, #7c6cff, #22d3ee)" }}
      >
        <FolderGit2 size={18} />
      </span>
      {!collapsed && (
        <span className="leading-tight">
          <span className="block text-sm font-bold tracking-tight">Git Team</span>
          <span className="block text-[11px] text-muted">Manager console</span>
        </span>
      )}
    </Link>
  );
}

function SidebarContent({ items, onNavigate, compact }: { items: NavItem[]; onNavigate?: () => void; compact?: boolean }) {
  const { me, live } = useSession();
  const qc = useQueryClient();
  const [theme, setTheme] = useState<ThemePref>(getThemePref);

  const cycleTheme = () => {
    const next: ThemePref = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    setTheme(next);
    setThemePref(next);
  };
  const ThemeIcon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      qc.clear();
      qc.setQueryData(qk.me, null);
    }
  };

  // compact = icon rail on tablet widths (md..lg)
  const hideOnRail = compact ? "md:hidden lg:inline" : "";

  return (
    <div className="flex h-full flex-col">
      <div className={cn("px-4 pt-5 pb-6", compact && "md:px-3 lg:px-4")}>
        <span className={compact ? "md:hidden lg:block" : ""}>
          <Logo />
        </span>
        {compact && (
          <span className="hidden md:block lg:hidden">
            <Logo collapsed />
          </span>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 px-2.5">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            title={item.label}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition",
                isActive ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-3 hover:text-fg",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                <item.icon size={18} className={isActive ? "text-accent" : ""} />
                <span className={cn("flex-1", hideOnRail)}>{item.label}</span>
                {!!item.badge && (
                  <span
                    className={cn(
                      "rounded-full bg-accent px-1.5 py-px text-[11px] font-semibold text-accent-fg tabular-nums",
                      compact && "md:absolute md:top-0.5 md:right-0.5 md:px-1 md:text-[9px] lg:static lg:px-1.5 lg:text-[11px]",
                    )}
                  >
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-1 border-t border-border p-2.5">
        <div className={cn("flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted", compact && "md:justify-center lg:justify-start")}>
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              live === "open" ? "bg-success" : live === "connecting" ? "animate-pulse bg-warning" : "bg-danger",
            )}
            title={`Live updates: ${live}`}
          />
          <span className={hideOnRail}>{live === "open" ? "Live" : live === "connecting" ? "Connecting…" : "Offline"}</span>
        </div>
        <button onClick={cycleTheme} className="btn-ghost w-full justify-start px-2.5" title={`Theme: ${theme}`}>
          <ThemeIcon size={16} />
          <span className={cn("capitalize", hideOnRail)}>Theme: {theme}</span>
        </button>
        <div className={cn("flex items-center gap-2 rounded-lg px-2.5 py-2", compact && "md:justify-center lg:justify-start")}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold">
            {(me.name || me.username).slice(0, 1).toUpperCase()}
          </span>
          <div className={cn("min-w-0 flex-1", hideOnRail)}>
            <div className="truncate text-sm font-medium">{me.name || me.username}</div>
            <div className="truncate text-[11px] text-muted">Manager · {me.email}</div>
          </div>
          <button onClick={logout} className={cn("text-subtle hover:text-fg", hideOnRail)} title="Log out">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Layout() {
  const features = useFeatures();
  const { data: unread } = useUnread();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const items: NavItem[] = [
    { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
    { to: "/projects", label: "Projects", icon: FolderGit2 },
    { to: "/team", label: "Team", icon: Users },
    { to: "/inbox", label: "Inbox", icon: Mail, badge: unread?.count },
    ...(features.leaderboard
      ? [
          { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
          { to: "/reviews", label: "Reviews", icon: ClipboardCheck },
        ]
      : []),
    { to: "/settings", label: "Settings", icon: SettingsIcon },
  ];

  const wide = location.pathname.startsWith("/inbox");

  return (
    <ActiveCallProvider>
    <div className="flex h-full">
      {/* Desktop / tablet sidebar */}
      <aside className="hidden shrink-0 border-r border-border bg-surface md:block md:w-[68px] lg:w-60">
        <div className="sticky top-0 h-screen">
          <SidebarContent items={items} compact />
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute top-0 left-0 h-full w-64 animate-fade-in border-r border-border bg-surface">
            <button className="btn-ghost absolute top-4 right-2 p-1.5" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X size={18} />
            </button>
            <SidebarContent items={items} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 md:hidden">
          <button className="btn-ghost p-1.5" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={20} />
          </button>
          <Logo />
        </header>
        {features.paused && (
          <div className="flex items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
            <PauseCircle size={16} />
            All agents are paused — no new runs will start.
            <Link to="/settings" className="font-medium underline underline-offset-2">
              Resume in Settings
            </Link>
          </div>
        )}
        <main className={cn("min-h-0 flex-1", wide ? "" : "overflow-y-auto")}>
          <div className={cn(wide ? "h-full" : "mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8")}>
            <Suspense fallback={<Loading />}>
              <Outlet />
            </Suspense>
            <ActiveCallDock />
          </div>
        </main>
      </div>
    </div>
    </ActiveCallProvider>
  );
}
