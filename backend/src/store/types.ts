/**
 * Abstracción mínima de la tabla única (single-table design) con la semántica que
 * necesitamos de DynamoDB: Get/Put/Delete condicionales, TransactWrite atómica y
 * Query por partición + rango (tabla base o GSI).
 *
 * Implementaciones:
 *  - DynamoStore (nube real, AWS DynamoDB).
 *  - MemoryStore (EMULADOR LOCAL etiquetado; NO equivale a la nube).
 * Toda la lógica de claves, índices y consistencia vive en repo/ y es compartida.
 */
export interface Item {
  pk: string;
  sk: string;
  gsi1pk?: string;
  gsi1sk?: string;
  gsi2pk?: string;
  gsi2sk?: string;
  /** TTL en epoch seconds (sólo datos temporales). */
  ttl?: number;
  version?: number;
  [k: string]: unknown;
}

export type Condition =
  | { kind: 'notExists' }
  | { kind: 'exists' }
  | { kind: 'version'; version: number }
  | { kind: 'attrEquals'; attr: string; value: string | number | boolean };

export type TxOp =
  | { type: 'put'; item: Item; condition?: Condition }
  | { type: 'delete'; pk: string; sk: string; condition?: Condition }
  | { type: 'check'; pk: string; sk: string; condition: Condition }
  /** Actualización parcial: ADD atómico de contadores y SET de atributos (sin reescribir el ítem). */
  | { type: 'update'; pk: string; sk: string; add?: Record<string, number>; set?: Record<string, unknown>; condition?: Condition };

export type IndexName = 'base' | 'gsi1' | 'gsi2';

export interface QueryInput {
  index?: IndexName;
  pk: string;
  skBetween?: [string, string];
  skBeginsWith?: string;
  skGreaterThan?: string;
  limit?: number;
  cursor?: string;
  descending?: boolean;
  /** Lectura fuertemente consistente (sólo tabla base). */
  consistent?: boolean;
}

export interface QueryResult {
  items: Item[];
  cursor?: string;
}

export interface ChangeRecord {
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE';
  newImage?: Item;
  oldImage?: Item;
}

export interface TableStore {
  readonly kind: 'dynamodb' | 'memory';
  get(pk: string, sk: string, opts?: { consistent?: boolean }): Promise<Item | undefined>;
  put(item: Item, condition?: Condition): Promise<void>;
  delete(pk: string, sk: string, condition?: Condition): Promise<void>;
  transact(ops: TxOp[]): Promise<void>;
  query(q: QueryInput): Promise<QueryResult>;
  /**
   * Incremento ATÓMICO de un contador (UpdateItem ADD) sólo si el valor actual es
   * menor que `max`. Devuelve el nuevo valor o lanza ConditionFailedError.
   */
  increment(pk: string, sk: string, attr: string, opts: { max: number; ttl?: number }): Promise<number>;
}

/** Fallo de condición (equivalente a ConditionalCheckFailed / TransactionCanceled). */
export class ConditionFailedError extends Error {
  constructor(
    message: string,
    /** Motivo por operación (null = ok) en transacciones. */
    public readonly reasons: (string | null)[] = [],
  ) {
    super(message);
    this.name = 'ConditionFailedError';
  }
}

/** Conflicto transitorio entre transacciones concurrentes: se puede reintentar. */
export class TransientConflictError extends Error {
  constructor(message = 'Conflicto transaccional transitorio') {
    super(message);
    this.name = 'TransientConflictError';
  }
}

export async function queryAll(store: TableStore, q: QueryInput, max = 5000): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | undefined;
  do {
    const r = await store.query({ ...q, cursor, limit: Math.min(q.limit ?? 500, max - out.length) });
    out.push(...r.items);
    cursor = r.cursor;
  } while (cursor && out.length < max);
  return out;
}

export function encodeCursor(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}
export function decodeCursor<T>(c: string): T {
  try {
    return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T;
  } catch {
    throw new Error('Cursor de paginación inválido');
  }
}
