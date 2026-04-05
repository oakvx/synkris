import { Prisma } from "@prisma/client";
import type {
  OperationsAppointment,
  OperationsAppointmentsResponse,
  OperationsClient,
  OperationsClientsResponse,
  OperationsSummary,
} from "@whatsapp-ai/shared";

import { prisma } from "../lib/prisma.js";
import { normalizeDigits, stringifyId, toIsoString } from "../lib/serialize.js";

type ListAppointmentsOptions = {
  from?: Date | null;
  limit?: number;
  search?: string | null;
  status?: string | null;
  to?: Date | null;
};

type ListClientsOptions = {
  limit?: number;
  search?: string | null;
};

type AppointmentRow = Prisma.AppointmentGetPayload<{
  include: {
    client: {
      include: {
        contacts: true;
      };
    };
    professional: true;
    appointmentServices: {
      include: {
        service: true;
      };
    };
    appointmentCalendar: true;
    appointmentFlag: true;
  };
}>;

type ClientRow = Prisma.ClientGetPayload<{
  include: {
    contacts: true;
    _count: {
      select: {
        appointments: true;
      };
    };
  };
}>;

type ClientAppointmentRow = {
  clientId: bigint;
  startTime: Date;
};

type ChatSessionRow = {
  chatId: string;
  phoneE164: string | null;
  lastActiveAt: Date | null;
};

function startOfToday() {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfToday() {
  const value = startOfToday();
  value.setDate(value.getDate() + 1);
  return value;
}

function compactSearch(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildAppointmentWhere(filters: ListAppointmentsOptions): Prisma.AppointmentWhereInput {
  const where: Prisma.AppointmentWhereInput = {};
  const search = compactSearch(filters.search);

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.from || filters.to) {
    where.startTime = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  if (search) {
    where.OR = [
      { client: { fullName: { contains: search, mode: "insensitive" } } },
      { client: { contacts: { some: { value: { contains: search, mode: "insensitive" } } } } },
      { professional: { fullName: { contains: search, mode: "insensitive" } } },
      {
        appointmentServices: {
          some: {
            service: {
              serviceName: { contains: search, mode: "insensitive" },
            },
          },
        },
      },
    ];
  }

  return where;
}

function buildClientWhere(search: string | null | undefined): Prisma.ClientWhereInput {
  const trimmed = compactSearch(search);
  if (!trimmed) {
    return {};
  }

  return {
    OR: [
      { fullName: { contains: trimmed, mode: "insensitive" } },
      { contacts: { some: { value: { contains: trimmed, mode: "insensitive" } } } },
    ],
  };
}

function mapAppointment(appointment: AppointmentRow): OperationsAppointment {
  const clientPhone = appointment.client.contacts.find((entry) => entry.type === "phone")?.value ?? null;
  const clientWhatsapp =
    appointment.client.contacts.find((entry) => entry.type.toLowerCase().includes("whatsapp"))?.value ?? null;

  return {
    appointmentId: stringifyId(appointment.appointmentId),
    status: appointment.status,
    startTime: appointment.startTime.toISOString(),
    endTime: appointment.endTime.toISOString(),
    clientName: appointment.client.fullName,
    clientPhone,
    clientWhatsapp,
    professionalName: appointment.professional.fullName,
    serviceNames: appointment.appointmentServices.map((entry) => entry.service.serviceName),
    serviceDurationMin: appointment.appointmentServices.reduce((sum, entry) => sum + entry.durationMin, 0),
    calendarProvider: appointment.appointmentCalendar?.provider ?? null,
    calendarEventId: appointment.appointmentCalendar?.eventId ?? null,
    confirmAskedAt: toIsoString(appointment.appointmentFlag?.confirmAskedAt),
    reviewAskedAt: toIsoString(appointment.appointmentFlag?.reviewAskedAt),
  };
}

export class OperationsRepository {
  async getSummary(): Promise<OperationsSummary> {
    const now = new Date();
    const todayStart = startOfToday();
    const todayEnd = endOfToday();
    const chatCutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);

    const [
      totalClients,
      upcomingAppointments,
      todayAppointments,
      activeHolds,
      activeChatSessions,
      activeProfessionals,
    ] = await prisma.$transaction([
      prisma.client.count(),
      prisma.appointment.count({ where: { startTime: { gte: now } } }),
      prisma.appointment.count({ where: { startTime: { gte: todayStart, lt: todayEnd } } }),
      prisma.appointmentHold.count({ where: { status: "active", expiresAt: { gte: now } } }),
      prisma.chatSession.count({ where: { lastActiveAt: { gte: chatCutoff } } }),
      prisma.professional.count({ where: { isActive: true } }),
    ]);

    return {
      totalClients,
      upcomingAppointments,
      todayAppointments,
      activeHolds,
      activeChatSessions,
      activeProfessionals,
    };
  }

  async listAppointments(filters: ListAppointmentsOptions = {}): Promise<OperationsAppointmentsResponse> {
    const where = buildAppointmentWhere(filters);
    const take = Math.min(Math.max(filters.limit ?? 40, 1), 100);

    const [total, appointments] = await prisma.$transaction([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        orderBy: { startTime: "asc" },
        take,
        include: {
          client: {
            include: {
              contacts: true,
            },
          },
          professional: true,
          appointmentServices: {
            include: {
              service: true,
            },
          },
          appointmentCalendar: true,
          appointmentFlag: true,
        },
      }),
    ]);

    return {
      total,
      appointments: appointments.map(mapAppointment),
    };
  }

  async listClients(filters: ListClientsOptions = {}): Promise<OperationsClientsResponse> {
    const where = buildClientWhere(filters.search);
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 100);

    const [total, clients] = await prisma.$transaction([
      prisma.client.count({ where }),
      prisma.client.findMany({
        where,
        orderBy: { fullName: "asc" },
        take,
        include: {
          contacts: true,
          _count: {
            select: {
              appointments: true,
            },
          },
        },
      }),
    ]);

    const clientIds = clients.map((entry) => entry.clientId);
    const contactValues = clients.flatMap((entry) => entry.contacts.map((contact) => contact.value));
    const normalizedPhones = [...new Set(contactValues.map((value) => normalizeDigits(value)).filter(Boolean))] as string[];
    const chatIds = [
      ...new Set(
        clients.flatMap((entry) =>
          entry.contacts
            .filter((contact) => contact.type.toLowerCase().includes("whatsapp"))
            .map((contact) => contact.value),
        ),
      ),
    ];

    const [appointments, sessions] = await Promise.all([
      clientIds.length
        ? prisma.appointment.findMany({
            where: {
              clientId: {
                in: clientIds,
              },
            },
            orderBy: { startTime: "asc" },
            select: {
              clientId: true,
              startTime: true,
            },
          })
        : Promise.resolve([] as ClientAppointmentRow[]),
      normalizedPhones.length || chatIds.length
        ? prisma.chatSession.findMany({
            where: {
              OR: [
                normalizedPhones.length ? { phoneE164: { in: normalizedPhones } } : undefined,
                chatIds.length ? { chatId: { in: chatIds } } : undefined,
              ].filter(Boolean) as Prisma.ChatSessionWhereInput[],
            },
            select: {
              chatId: true,
              phoneE164: true,
              lastActiveAt: true,
            },
          })
        : Promise.resolve([] as ChatSessionRow[]),
    ] as const);

    const now = new Date();
    const appointmentMap = new Map<string, { last: Date | null; next: Date | null }>();
    for (const appointment of appointments) {
      const key = stringifyId(appointment.clientId);
      const current = appointmentMap.get(key) ?? { last: null, next: null };

      if (!current.last || appointment.startTime > current.last) {
        current.last = appointment.startTime;
      }

      if (appointment.startTime >= now && (!current.next || appointment.startTime < current.next)) {
        current.next = appointment.startTime;
      }

      appointmentMap.set(key, current);
    }

    const sessionMap = new Map<string, Date>();
    for (const session of sessions) {
      if (!session.lastActiveAt) {
        continue;
      }

      const keys = [session.chatId, normalizeDigits(session.phoneE164)].filter(Boolean) as string[];
      for (const key of keys) {
        const current = sessionMap.get(key);
        if (!current || session.lastActiveAt > current) {
          sessionMap.set(key, session.lastActiveAt);
        }
      }
    }

    const mappedClients: OperationsClient[] = (clients as ClientRow[]).map((client) => {
      const appointmentInfo = appointmentMap.get(stringifyId(client.clientId)) ?? { last: null, next: null };
      const lastChatAt = client.contacts.reduce<Date | null>((latest, contact) => {
        const candidates = [contact.value, normalizeDigits(contact.value)].filter(Boolean) as string[];
        for (const candidate of candidates) {
          const sessionDate = sessionMap.get(candidate);
          if (sessionDate && (!latest || sessionDate > latest)) {
            latest = sessionDate;
          }
        }
        return latest;
      }, null);

      return {
        clientId: stringifyId(client.clientId),
        fullName: client.fullName,
        contacts: client.contacts.map((contact) => ({
          type: contact.type,
          value: contact.value,
        })),
        appointmentsCount: client._count.appointments,
        lastAppointmentAt: toIsoString(appointmentInfo.last),
        nextAppointmentAt: toIsoString(appointmentInfo.next),
        lastChatAt: toIsoString(lastChatAt),
      };
    });

    return {
      total,
      clients: mappedClients,
    };
  }
}
