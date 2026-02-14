import { ResearchPage } from "../pages/Research";
import { ResearchJobDetailsPage } from "../pages/ResearchJobDetails";
import type { DashboardPlugin } from "./types";

export const tigerResearchPlugin: DashboardPlugin = {
  id: "tiger-research",
  name: "TigerResearch",
  description: "High-precision claim/evidence research pipeline",
  entryPath: "/plugins/tiger-research",
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
