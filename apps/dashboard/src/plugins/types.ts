import type { ReactElement } from "react";

export interface DashboardPluginRoute {
  path: string;
  element: ReactElement;
}

export interface DashboardPluginNavItem {
  to: string;
  label: string;
}

export interface DashboardPlugin {
  id: string;
  name: string;
  description: string;
  entryPath: string;
  navItems: DashboardPluginNavItem[];
  routes: DashboardPluginRoute[];
}
