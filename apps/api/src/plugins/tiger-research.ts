import type { ApiPlugin } from "./types";
import { researchRoute } from "../routes/research";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

export const tigerResearchApiPlugin: ApiPlugin = {
  id: tigerResearchPluginManifest.id,
  name: tigerResearchPluginManifest.name,
  description: tigerResearchPluginManifest.description,
  registerRoutes: (app) => {
    app.route("/plugins/tiger-research", researchRoute);
  },
};
