import { ResearchPage } from "../pages/Research";
import { ResearchJobDetailsPage } from "../pages/ResearchJobDetails";
import type { DashboardPlugin } from "./types";
import { tigerResearchPluginManifestCore } from "@openTiger/plugin-tiger-research/manifest";

export const tigerResearchPlugin: DashboardPlugin = {
  id: tigerResearchPluginManifestCore.id,
  name: tigerResearchPluginManifestCore.name,
  description: tigerResearchPluginManifestCore.description,
  entryPath: tigerResearchPluginManifestCore.dashboard?.entryPath ?? "/plugins/tiger-research",
  navItems: [{ to: "/plugins/tiger-research", label: "tiger-research" }],
  routes: [
    {
      path: "/plugins/tiger-research",
      element: <ResearchPage />,
    },
    {
      path: "/plugins/tiger-research/:id",
      element: <ResearchJobDetailsPage />,
    },
  ],
};

export const dashboardPlugin = tigerResearchPlugin;
