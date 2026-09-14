import { Suspense, useEffect, useState } from "react";
import {
  FileDown,
  GraduationCap,
  LayoutDashboard,
  MessageSquare,
  Receipt,
  Settings,
  Users,
  Wallet,
  WifiOff,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { useFirestoreSync } from "@/lib/ennajd-firestore-sync";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function useNavItems() {
  const { t } = useI18n();
  return [
    { to: "/", label: t("dashboard"), icon: LayoutDashboard },
    { to: "/students", label: t("students"), icon: Users },
    { to: "/sessions", label: t("sessions"), icon: GraduationCap },
    { to: "/messages", label: t("messages"), icon: MessageSquare },
    { to: "/pricing", label: t("pricing"), icon: Wallet },
    { to: "/payments", label: t("payments"), icon: Receipt },
    { to: "/reports", label: t("reportGenerator"), icon: FileDown },
  ];
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return isOnline;
}

function ConnectionBadge() {
  const isOnline = useOnlineStatus();
  const { lang } = useI18n();

  if (isOnline) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
      <WifiOff className="h-3.5 w-3.5" />
      <span>{lang === "ar" ? "دون اتصال" : "Hors ligne"}</span>
    </div>
  );
}

export function AppShell() {
  const { t, lang } = useI18n();
  const navItems = useNavItems();

  // Sync Supabase data continuously
  useFirestoreSync();

  return (
    <SidebarProvider>
      <Sidebar side={lang === "ar" ? "right" : "left"}>
        <SidebarHeader className="px-3 py-4">
          <div className="flex items-center gap-2.5">
            <img
              src="https://i.postimg.cc/3JX2NjHn/logo-png.png"
              alt={t("appName")}
              className={cn(
                "h-12 w-auto shrink-0 rounded-xl object-contain shadow-sm",
                lang === "ar" ? "ml-3" : "mr-3",
              )}
              loading="eager"
              decoding="async"
            />
            <div className="flex flex-col justify-center leading-tight">
              <span className="text-sm font-bold text-sidebar-foreground">
                {t("appName")}
              </span>
              <span className="text-[11px] text-sidebar-foreground/60">
                ERP
              </span>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="text-sidebar-foreground/50">
              {t("appName")}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <NavLink to={item.to} end={item.to === "/"}>
                      {({ isActive }) => (
                        <SidebarMenuButton
                          isActive={isActive}
                          className={cn(
                            "rounded-lg",
                            isActive &&
                              "bg-sidebar-accent text-sidebar-accent-foreground",
                          )}
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-3 py-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton className="rounded-lg" disabled>
                <Settings className="h-4 w-4" />
                <span>{t("settings")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-3 backdrop-blur-sm sm:px-6">
          <SidebarTrigger className="text-foreground" />
          <div className="flex-1" />
          <ConnectionBadge />
          <NotificationBell />
          <LanguageToggle />
          <ThemeToggle />
        </header>
        <main className="flex-1 p-4 sm:p-6">
          {/* Pages are preloaded right after sign-in, so this boundary only
              suspends on the brief cold-start first visit — hence the null
              fallback (no spinner flash between routes). */}
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
