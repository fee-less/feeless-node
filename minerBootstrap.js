import fs from "fs";
import { spawnSync } from "child_process";

const builtFile = path.resolve(__dirname, "dist", "miner2.js");

if (fs.existsSync(builtFile)) require(builtFile);
else {
  console.log("Compiled Feeless Miner not found. Building...");
  const result = spawnSync("npx", ["tsc"], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Build failed.");
    process.exit(result.status);
  }
  require(builtFile);
}