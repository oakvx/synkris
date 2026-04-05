import type {
  OperationsAppointmentsResponse,
  OperationsClientsResponse,
  OperationsSummary,
} from "@whatsapp-ai/shared";

import { OperationsRepository } from "../repositories/operationsRepository.js";

type AppointmentsFilters = {
  from?: string | null;
  limit?: number;
  search?: string | null;
  status?: string | null;
  to?: string | null;
};

type ClientsFilters = {
  limit?: number;
  search?: string | null;
};

function parseOptionalDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class OperationsService {
  constructor(private readonly operationsRepository = new OperationsRepository()) {}

  getSummary(): Promise<OperationsSummary> {
    return this.operationsRepository.getSummary();
  }

  listAppointments(filters: AppointmentsFilters = {}): Promise<OperationsAppointmentsResponse> {
    return this.operationsRepository.listAppointments({
      from: parseOptionalDate(filters.from),
      to: parseOptionalDate(filters.to),
      limit: filters.limit,
      search: filters.search,
      status: filters.status,
    });
  }

  listClients(filters: ClientsFilters = {}): Promise<OperationsClientsResponse> {
    return this.operationsRepository.listClients(filters);
  }
}
