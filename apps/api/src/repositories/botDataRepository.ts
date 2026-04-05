import { Prisma, type PrismaClient } from "@prisma/client";

import { HttpError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

type PrismaModelField = (typeof Prisma.dmmf.datamodel.models)[number]["fields"][number];
type PrismaModel = (typeof Prisma.dmmf.datamodel.models)[number];
type BotRow = Record<string, unknown>;

const hiddenModels = new Set(["User", "UserSettings", "PasswordResetToken"]);

const editableModels = Prisma.dmmf.datamodel.models.filter((model) => !hiddenModels.has(model.name));
const editableModelMap = new Map(editableModels.map((model) => [model.name.toLowerCase(), model]));

function isDecimalLike(value: unknown): value is { toString: () => string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "constructor" in value &&
    typeof (value as { constructor?: { name?: string } }).constructor?.name === "string" &&
    (value as { constructor: { name: string } }).constructor.name === "Decimal"
  );
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isDecimalLike(value)) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return (value as unknown[]).map((entry) => serializeValue(entry));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeValue(entry)]),
    );
  }

  return value;
}

function delegateFor(client: PrismaClient | Prisma.TransactionClient, model: PrismaModel) {
  const delegateName = `${model.name.charAt(0).toLowerCase()}${model.name.slice(1)}` as keyof PrismaClient;
  const delegate = (client as Record<string, unknown>)[delegateName as string] as {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<unknown>;
    findMany: (args: { select: Record<string, true> }) => Promise<BotRow[]>;
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>;
  };

  if (!delegate) {
    throw new HttpError(404, `Delegate Prisma non disponibile per ${model.name}.`);
  }

  return delegate;
}

function keyFieldsFor(model: PrismaModel): string[] {
  if (model.primaryKey?.fields.length) {
    return [...model.primaryKey.fields];
  }

  const idFields = model.fields.filter((field) => field.isId).map((field) => field.name);
  if (idFields.length) {
    return idFields;
  }

  const compoundUnique = model.uniqueFields.find((fieldSet) => fieldSet.length > 0);
  if (compoundUnique) {
    return [...compoundUnique];
  }

  const singleUnique = model.fields.find((field) => field.isUnique);
  if (singleUnique) {
    return [singleUnique.name];
  }

  throw new HttpError(400, `Il modello ${model.name} non ha una chiave primaria o un indice univoco gestibile.`);
}

function scalarFieldsFor(model: PrismaModel): PrismaModelField[] {
  return model.fields.filter((field) => field.kind === "scalar");
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }

  return Boolean(value);
}

function parseFieldValue(field: PrismaModelField, value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    if (field.isRequired && !field.isUpdatedAt) {
      throw new HttpError(400, `Il campo ${field.name} non puo' essere null.`);
    }
    return null;
  }

  switch (field.type) {
    case "BigInt":
      return typeof value === "bigint" ? value : BigInt(String(value));
    case "Int": {
      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isFinite(parsed)) {
        throw new HttpError(400, `Il campo ${field.name} richiede un intero valido.`);
      }
      return parsed;
    }
    case "Float": {
      const parsed = Number.parseFloat(String(value));
      if (!Number.isFinite(parsed)) {
        throw new HttpError(400, `Il campo ${field.name} richiede un numero valido.`);
      }
      return parsed;
    }
    case "Decimal":
      return new Prisma.Decimal(String(value));
    case "Boolean":
      return normalizeBoolean(value);
    case "DateTime": {
      const parsed = new Date(String(value));
      if (Number.isNaN(parsed.getTime())) {
        throw new HttpError(400, `Il campo ${field.name} richiede una data ISO valida.`);
      }
      return parsed;
    }
    case "Json":
      return value;
    default:
      return value;
  }
}

function buildWhereFromKey(model: PrismaModel, row: BotRow): Record<string, unknown> {
  const keyFields = keyFieldsFor(model);
  const filters = keyFields.map((fieldName) => {
    const field = scalarFieldsFor(model).find((entry) => entry.name === fieldName);
    if (!field) {
      throw new HttpError(400, `Chiave ${fieldName} non trovata nel modello ${model.name}.`);
    }

    if (!(fieldName in row)) {
      throw new HttpError(400, `Il campo chiave ${fieldName} e' obbligatorio per ${model.name}.`);
    }

    return {
      [fieldName]: parseFieldValue(field, row[fieldName]),
    };
  });

  if (filters.length === 1) {
    return filters[0] as Record<string, unknown>;
  }

  return { AND: filters };
}

function hasCompleteKey(model: PrismaModel, row: BotRow): boolean {
  return keyFieldsFor(model).every((fieldName) => {
    if (!(fieldName in row)) {
      return false;
    }

    const value = row[fieldName];
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === "string" && value.trim() === "") {
      return false;
    }

    return true;
  });
}

function keyForRow(model: PrismaModel, row: BotRow): string {
  const keyObject = Object.fromEntries(
    keyFieldsFor(model).map((fieldName) => [fieldName, serializeValue(row[fieldName])]),
  );
  return JSON.stringify(keyObject);
}

function buildCreateData(model: PrismaModel, row: BotRow): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const field of scalarFieldsFor(model)) {
    if (field.isUpdatedAt) {
      continue;
    }

    const parsed = parseFieldValue(field, row[field.name]);
    if (parsed === undefined) {
      continue;
    }

    data[field.name] = parsed;
  }

  return data;
}

function validateRowCanBeCreated(model: PrismaModel, row: BotRow) {
  for (const fieldName of keyFieldsFor(model)) {
    const field = scalarFieldsFor(model).find((entry) => entry.name === fieldName);
    if (!field) {
      throw new HttpError(400, `Chiave ${fieldName} non trovata nel modello ${model.name}.`);
    }

    const value = row[fieldName];
    const isMissing =
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "");

    if (!isMissing) {
      continue;
    }

    if (field.hasDefaultValue || field.isGenerated) {
      continue;
    }

    throw new HttpError(400, `Il campo chiave ${field.name} e' obbligatorio per creare una nuova riga.`);
  }
}

function buildUpdateData(model: PrismaModel, row: BotRow): Record<string, unknown> {
  const keyFields = new Set(keyFieldsFor(model));
  const data: Record<string, unknown> = {};

  for (const field of scalarFieldsFor(model)) {
    if (field.isUpdatedAt || keyFields.has(field.name)) {
      continue;
    }

    const parsed = parseFieldValue(field, row[field.name]);
    if (parsed === undefined) {
      continue;
    }

    data[field.name] = parsed;
  }

  return data;
}

function selectFor(model: PrismaModel): Record<string, true> {
  return Object.fromEntries(scalarFieldsFor(model).map((field) => [field.name, true]));
}

function modelOrThrow(modelName: string): PrismaModel {
  const model = editableModelMap.get(modelName.trim().toLowerCase());
  if (!model) {
    throw new HttpError(404, `Modello ${modelName} non disponibile nel gestionale.`);
  }

  return model;
}

export class BotDataRepository {
  listModels() {
    return editableModels.map((model) => ({
      dbName: model.dbName,
      fields: scalarFieldsFor(model).map((field) => ({
        dbName: field.dbName,
        hasDefaultValue: field.hasDefaultValue,
        isGenerated: field.isGenerated,
        isId: field.isId,
        isList: field.isList,
        isReadOnly: field.isReadOnly,
        isRequired: field.isRequired,
        isUnique: field.isUnique,
        isUpdatedAt: field.isUpdatedAt,
        name: field.name,
        type: field.type,
      })),
      name: model.name,
      primaryKey: keyFieldsFor(model),
    }));
  }

  async getRows(modelName: string) {
    const model = modelOrThrow(modelName);
    const delegate = delegateFor(prisma, model);
    const rows = await delegate.findMany({ select: selectFor(model) });

    return {
      model: model.name,
      rowCount: rows.length,
      rows: rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeValue(value)])),
      ),
    };
  }

  async replaceRows(modelName: string, rows: BotRow[]) {
    const model = modelOrThrow(modelName);
    const current = await this.getRows(model.name);
    const existingMap = new Map(current.rows.map((row) => [keyForRow(model, row), row]));
    const incomingKeys = new Set<string>();
    const rowsToCreate: BotRow[] = [];

    await prisma.$transaction(async (transaction) => {
      const delegate = delegateFor(transaction, model);

      for (const row of rows) {
        if (!hasCompleteKey(model, row)) {
          validateRowCanBeCreated(model, row);
          rowsToCreate.push(row);
          continue;
        }

        const key = keyForRow(model, row);
        incomingKeys.add(key);
        const where = buildWhereFromKey(model, row);

        if (existingMap.has(key)) {
          const data = buildUpdateData(model, row);
          if (Object.keys(data).length === 0) {
            continue;
          }

          await delegate.updateMany({ data, where });
          continue;
        }

        await delegate.create({
          data: buildCreateData(model, row),
        });
      }

      for (const [key, row] of existingMap.entries()) {
        if (incomingKeys.has(key)) {
          continue;
        }

        await delegate.deleteMany({
          where: buildWhereFromKey(model, row),
        });
      }

      for (const row of rowsToCreate) {
        await delegate.create({
          data: buildCreateData(model, row),
        });
      }
    });

    return this.getRows(model.name);
  }
}
