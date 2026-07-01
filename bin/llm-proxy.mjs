#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const entryFile = resolve(projectRoot, "src", "index.ts");

// 从项目根目录启动，确保 .env 和 upstreams.json 能正确加载
const child = spawn("npx", ["tsx", entryFile], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
