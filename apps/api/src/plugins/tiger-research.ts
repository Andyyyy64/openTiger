import type { ApiPlugin } from "./types";
import { researchRoute } from "../routes/research";

export const tigerResearchApiPlugin: ApiPlugin = {
  id: "tiger-research",
  name: "TigerResearch",
  description: "Claim-evidence-convergence research workflow plugin",
  registerRoutes: (app) => {
    app.route("/plugins/tiger-research", researchRoute);
    // Backward compatibility for existing clients
    app.route("/research", researchRoute);
  },
};
