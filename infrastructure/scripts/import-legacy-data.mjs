import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["01_migrate_json_to_pg.mjs"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
