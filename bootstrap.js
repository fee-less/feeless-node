#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

// Resolve __dirname (ESM-safe)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always resolve relative to CLI package directory
const projectRoot = path.resolve(__dirname); // where tsconfig.json is
const builtFile = path.join(projectRoot, "dist", "index.js");
const tscPath = path.join(projectRoot, "node_modules", ".bin", "tsc");

// Build if necessary
if (!fs.existsSync(builtFile)) {
  console.log("Compiled Feeless Node not found. Building...");
  const result = spawnSync(tscPath, [], {
    stdio: "inherit",
    cwd: projectRoot, // Force build to run from the right directory
    shell: true, // Required for .bin/tsc on Windows
  });

  if (result.status !== 0) {
    console.error("Build failed.");
    process.exit(result.status);
  }
}

// Execute built CLI
spawnSync("node", [builtFile, ...process.argv.slice(2)], {
  stdio: "inherit",
});
