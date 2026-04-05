import "dotenv/config";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { appointmentPushListenerService } from "./services/appointmentPushListenerService.js";

const app = createApp();

app.listen(env.port, "0.0.0.0", () => {
  console.log(`[api] listening on http://0.0.0.0:${env.port}`);
  void appointmentPushListenerService.start();
});
