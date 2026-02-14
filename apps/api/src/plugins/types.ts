import type { Hono } from "hono";

export interface ApiPlugin {
  id: string;
  name: string;
  description: string;
  registerRoutes: (app: Hono) => void;
}
