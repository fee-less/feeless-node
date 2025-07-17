import fs from "fs";
import { spawnSync } from "child_process";

const builtFile = path.resolve(__dirname, "dist", "index.js");

if (fs.existsSync(builtFile)) require(builtFile);
else {
  console.log("Compiled Feeless Node not found. Building...");
  const result = spawnSync("npx", ["tsc"], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Build failed.");
    process.exit(result.status);
  }
  require(builtFile);
}