import { Client, type Notification } from "pg";
import { z } from "zod";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { pushService } from "./pushService.js";

const AppointmentDbEventSchema = z.object({
  appointmentId: z.union([z.string(), z.number(), z.bigint()]),
  at: z.string().optional(),
  clientId: z.union([z.string(), z.number(), z.bigint()]).optional(),
  endTime: z.string().optional(),
  eventKind: z.enum(["created", "updated", "cancelled", "deleted"]),
  previousStatus: z.string().nullable().optional(),
  professionalId: z.union([z.string(), z.number(), z.bigint()]).optional(),
  startTime: z.string().optional(),
  status: z.string().optional(),
});

function formatDateTime(value: string | Date | null | undefined) {
  if (!value) {
    return "data da definire";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "data da definire";
  }

  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function stringifyServiceNames(names: string[]) {
  if (names.length === 0) {
    return "servizio da definire";
  }

  if (names.length === 1) {
    return names[0];
  }

  return `${names[0]} + ${names.length - 1} altri`;
}

export class AppointmentPushListenerService {
  private listenerClient: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private started = false;

  async start() {
    if (this.started || !pushService.isEnabled()) {
      if (!pushService.isEnabled()) {
        console.warn("[api] push disabilitate: listener appuntamenti non avviato.");
      }
      return;
    }

    this.started = true;
    await this.connect();
  }

  private async connect() {
    try {
      this.listenerClient = new Client({ connectionString: env.databaseUrl });
      this.listenerClient.on("error", (error: Error) => {
        console.warn("[api] listener appointment_events errore", error);
        this.scheduleReconnect();
      });
      this.listenerClient.on("end", () => {
        console.warn("[api] listener appointment_events terminato");
        this.scheduleReconnect();
      });
      this.listenerClient.on("notification", (message: Notification) => {
        if (!message.payload) {
          return;
        }

        void this.handleEvent(message.payload);
      });

      await this.listenerClient.connect();
      await this.listenerClient.query("LISTEN appointment_events");
      console.log("[api] listener appointment_events attivo");
    } catch (error) {
      console.warn("[api] impossibile avviare listener appointment_events", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    if (this.listenerClient) {
      void this.listenerClient.end().catch(() => undefined);
      this.listenerClient = null;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 5000);
  }

  private async handleEvent(rawPayload: string) {
    let event: z.infer<typeof AppointmentDbEventSchema>;

    try {
      event = AppointmentDbEventSchema.parse(JSON.parse(rawPayload));
    } catch (error) {
      console.warn("[api] payload appointment_events non valido", { rawPayload, error });
      return;
    }

    const appointmentId = BigInt(event.appointmentId);
    const payload = event.eventKind === "deleted"
      ? {
          title: "Prenotazione eliminata",
          body: `Appuntamento del ${formatDateTime(event.startTime)} rimosso dal calendario.`,
          url: "/#/operations",
          tag: `appointment-deleted-${appointmentId.toString()}`,
          data: {
            appointmentId: appointmentId.toString(),
            eventKind: event.eventKind,
          },
        }
      : await this.composeActiveAppointmentPayload(appointmentId, event.eventKind);

    if (!payload) {
      return;
    }

    await pushService.broadcastAppointmentEvent(payload);
  }

  private async composeActiveAppointmentPayload(
    appointmentId: bigint,
    eventKind: "created" | "updated" | "cancelled",
  ) {
    const appointment = await prisma.appointment.findUnique({
      where: { appointmentId },
      include: {
        client: true,
        professional: true,
        appointmentServices: {
          include: {
            service: true,
          },
        },
      },
    });

    if (!appointment) {
      return null;
    }

    const serviceNames = appointment.appointmentServices.map((entry) => entry.service.serviceName);
    const serviceLabel = stringifyServiceNames(serviceNames);
    const clientName = appointment.client.fullName;
    const professionalName = appointment.professional.fullName;
    const startLabel = formatDateTime(appointment.startTime);

    const bodyBase = `${clientName} · ${serviceLabel} · ${startLabel}`;
    const body =
      eventKind === "cancelled"
        ? `${bodyBase} · ${professionalName}`
        : `${bodyBase} · ${professionalName}`;

    const title =
      eventKind === "created"
        ? "Nuova prenotazione"
        : eventKind === "cancelled"
          ? "Prenotazione cancellata"
          : "Prenotazione modificata";

    return {
      title,
      body,
      url: "/#/operations",
      tag: `appointment-${eventKind}-${appointment.appointmentId.toString()}`,
      data: {
        appointmentId: appointment.appointmentId.toString(),
        eventKind,
      },
    };
  }
}

export const appointmentPushListenerService = new AppointmentPushListenerService();
