import type { ConnectionMode } from "@whatsapp-ai/shared";

import type { SessionRecord, WhatsAppProvider } from "./types.js";

export class OpenWaLegacyProvider implements WhatsAppProvider {
  async initialize(_record: SessionRecord, _mode: ConnectionMode): Promise<SessionRecord> {
    throw new Error(
      "Provider open-wa non ancora collegato al nuovo worker. Punto di integrazione previsto: index.js/util.js legacy in root.",
    );
  }

  async getStatus(_record: SessionRecord): Promise<SessionRecord> {
    throw new Error(
      "Provider open-wa non ancora collegato al nuovo worker. Punto di integrazione previsto: index.js/util.js legacy in root.",
    );
  }

  async disconnect(_record: SessionRecord): Promise<SessionRecord> {
    throw new Error(
      "Provider open-wa non ancora collegato al nuovo worker. Punto di integrazione previsto: index.js/util.js legacy in root.",
    );
  }
}
