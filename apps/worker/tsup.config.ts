import { createNodeConfig } from "../../tsup.config.base";

export default createNodeConfig({
  entry: ["src/main.ts", "src/start.ts"],
});
