import "dotenv/config";

import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = await createApp();

app.listen(env.port, "0.0.0.0", () => {
  console.log(`[bot-worker] listening on http://0.0.0.0:${env.port}`);
});
