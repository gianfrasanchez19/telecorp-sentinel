import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ConditionFailedError,
  decodeCursor,
  encodeCursor,
  type ChangeRecord,
  type Condition,
  type Item,
  type QueryInput,
  type QueryResult,
  type TableStore,
  type TxOp,
} from './types.js';

/**
 * EMULADOR LOCAL de la tabla DynamoDB (etiquetado; no equivale a la nube real).
 * Reproduce: condiciones, transacciones todo-o-nada, partición+rango, GSIs con
 * consistencia eventual simulada opcional y un "stream" de cambios asíncrono.
 * Cada operación cede el event loop antes de leer/confirmar para que las pruebas
 * de concurrencia puedan intercalar operaciones como ocurriría en la nube.
 */
export class MemoryStore implements TableStore {
  readonly kind = 'memory' as const;
  private parts = new Map<string, Map<string, Item>>();
  private listeners: ((c: ChangeRecord) => void)[] = [];
  private saveTimer?: NodeJS.Timeout;
  /** Índices secundarios: "gsi1|<pk>" -> claves "pk\u0000sk". */
  private gsi = new Map<string, Set<string>>();

  constructor(private readonly opts: { file?: string; yieldEveryOp?: boolean } = {}) {
    if (opts.file && existsSync(opts.file)) {
      const data = JSON.parse(readFileSync(opts.file, 'utf8')) as Item[];
      for (const it of data) {
        this.raw(it.pk).set(it.sk, it);
        this.indexAdd(it);
      }
    }
  }

  onChange(cb: (c: ChangeRecord) => void): void {
    this.listeners.push(cb);
  }

  private raw(pk: string): Map<string, Item> {
    let p = this.parts.get(pk);
    if (!p) {
      p = new Map();
      this.parts.set(pk, p);
    }
    return p;
  }

  private indexAdd(it: Item): void {
    for (const g of ['gsi1', 'gsi2'] as const) {
      const v = it[`${g}pk`];
      if (typeof v !== 'string') continue;
      const k = `${g}|${v}`;
      let set = this.gsi.get(k);
      if (!set) this.gsi.set(k, (set = new Set()));
      set.add(`${it.pk}\u0000${it.sk}`);
    }
  }

  private indexRemove(it: Item): void {
    for (const g of ['gsi1', 'gsi2'] as const) {
      const v = it[`${g}pk`];
      if (typeof v === 'string') this.gsi.get(`${g}|${v}`)?.delete(`${it.pk}\u0000${it.sk}`);
    }
  }

  private async yieldLoop(): Promise<void> {
    if (this.opts.yieldEveryOp !== false) await new Promise<void>((r) => setImmediate(r));
  }

  private current(pk: string, sk: string): Item | undefined {
    const it = this.parts.get(pk)?.get(sk);
    if (!it) return undefined;
    if (it.ttl && it.ttl * 1000 < Date.now()) return undefined; // TTL expirado
    return it;
  }

  private checkCond(pk: string, sk: string, c?: Condition): string | null {
    if (!c) return null;
    const cur = this.current(pk, sk);
    if (c.kind === 'notExists') return cur ? 'ConditionalCheckFailed' : null;
    if (c.kind === 'exists') return cur ? null : 'ConditionalCheckFailed';
    if (c.kind === 'attrEquals') return cur && cur[c.attr] === c.value ? null : 'ConditionalCheckFailed';
    return cur && (cur.version ?? 0) === c.version ? null : 'ConditionalCheckFailed';
  }

  private emit(c: ChangeRecord): void {
    const clone = structuredClone(c);
    // Asíncrono como DynamoDB Streams (nunca dentro de la escritura).
    setImmediate(() => {
      for (const l of this.listeners) l(clone);
    });
    this.scheduleSave();
  }

  private apply(op: TxOp): void {
    if (op.type === 'check') return;
    if (op.type === 'update') {
      const cur = this.current(op.pk, op.sk) ?? { pk: op.pk, sk: op.sk };
      const next: Item = { ...structuredClone(cur), ...structuredClone(op.set ?? {}) };
      for (const [k, v] of Object.entries(op.add ?? {})) next[k] = ((cur[k] as number | undefined) ?? 0) + v;
      this.apply({ type: 'put', item: next });
      return;
    }
    if (op.type === 'put') {
      const old = this.current(op.item.pk, op.item.sk);
      const prevRaw = this.parts.get(op.item.pk)?.get(op.item.sk);
      if (prevRaw) this.indexRemove(prevRaw);
      const item = structuredClone(op.item);
      this.raw(item.pk).set(item.sk, item);
      this.indexAdd(item);
      this.emit({ eventName: old ? 'MODIFY' : 'INSERT', newImage: item, oldImage: old });
    } else {
      const old = this.current(op.pk, op.sk);
      const prevRaw = this.parts.get(op.pk)?.get(op.sk);
      if (prevRaw) this.indexRemove(prevRaw);
      this.parts.get(op.pk)?.delete(op.sk);
      if (old) this.emit({ eventName: 'REMOVE', oldImage: old });
    }
  }

  async get(pk: string, sk: string): Promise<Item | undefined> {
    await this.yieldLoop();
    const it = this.current(pk, sk);
    return it ? structuredClone(it) : undefined;
  }

  async put(item: Item, condition?: Condition): Promise<void> {
    await this.transact([{ type: 'put', item, condition }]);
  }

  async delete(pk: string, sk: string, condition?: Condition): Promise<void> {
    await this.transact([{ type: 'delete', pk, sk, condition }]);
  }

  async transact(ops: TxOp[]): Promise<void> {
    if (ops.length > 100) throw new Error('TransactWrite admite como máximo 100 operaciones');
    const keyOf = (o: TxOp) => (o.type === 'put' ? `${o.item.pk}|${o.item.sk}` : `${o.pk}|${o.sk}`);
    const keys = new Set(ops.map(keyOf));
    if (keys.size !== ops.length) throw new Error('TransactWrite no admite dos operaciones sobre el mismo ítem');
    await this.yieldLoop();
    // Verificación y aplicación en el mismo turno del event loop => atomicidad.
    const reasons = ops.map((o) => (o.type === 'put' ? this.checkCond(o.item.pk, o.item.sk, o.condition) : this.checkCond(o.pk, o.sk, o.condition)));
    if (reasons.some((r) => r !== null)) {
      throw new ConditionFailedError(ops.length === 1 ? 'Conditional check failed' : 'Transaction cancelled', reasons);
    }
    for (const o of ops) this.apply(o);
  }

  async query(q: QueryInput): Promise<QueryResult> {
    await this.yieldLoop();
    const index = q.index ?? 'base';
    let candidates: Item[];
    let skOf: (i: Item) => string;
    if (index === 'base') {
      candidates = [...(this.parts.get(q.pk)?.values() ?? [])];
      skOf = (i) => i.sk;
    } else {
      const pkAttr = index === 'gsi1' ? 'gsi1pk' : 'gsi2pk';
      const skAttr = index === 'gsi1' ? 'gsi1sk' : 'gsi2sk';
      candidates = [];
      for (const key of this.gsi.get(`${index}|${q.pk}`) ?? []) {
        const [pk, sk] = key.split('\u0000');
        const it = this.parts.get(pk)?.get(sk);
        if (it && it[pkAttr] === q.pk && typeof it[skAttr] === 'string') candidates.push(it);
      }
      skOf = (i) => i[skAttr] as string;
    }
    const now = Date.now();
    let items = candidates.filter((i) => !(i.ttl && i.ttl * 1000 < now));
    if (q.skBetween) items = items.filter((i) => skOf(i) >= q.skBetween![0] && skOf(i) <= q.skBetween![1]);
    if (q.skBeginsWith) items = items.filter((i) => skOf(i).startsWith(q.skBeginsWith!));
    if (q.skGreaterThan) items = items.filter((i) => skOf(i) > q.skGreaterThan!);
    const tuple = (i: Item) => `${skOf(i)}\u0000${i.pk}\u0000${i.sk}`;
    items.sort((a, b) => (tuple(a) < tuple(b) ? -1 : tuple(a) > tuple(b) ? 1 : 0));
    if (q.descending) items.reverse();
    if (q.cursor) {
      const c = decodeCursor<{ t: string }>(q.cursor).t;
      items = items.filter((i) => (q.descending ? tuple(i) < c : tuple(i) > c));
    }
    const limit = q.limit ?? 100;
    const page = items.slice(0, limit);
    const cursor = items.length > limit ? encodeCursor({ t: tuple(page[page.length - 1]) }) : undefined;
    return { items: page.map((i) => structuredClone(i)), cursor };
  }

  async increment(pk: string, sk: string, attr: string, opts: { max: number; ttl?: number }): Promise<number> {
    await this.yieldLoop();
    const cur = this.current(pk, sk);
    const v = (cur?.[attr] as number | undefined) ?? 0;
    if (v >= opts.max) throw new ConditionFailedError('Conditional check failed', ['ConditionalCheckFailed']);
    this.apply({ type: 'put', item: { ...(cur ?? { pk, sk }), [attr]: v + 1, ...(opts.ttl ? { ttl: opts.ttl } : {}) } });
    return v + 1;
  }

  /** Sólo para pruebas y herramientas locales. */
  dump(): Item[] {
    const out: Item[] = [];
    for (const p of this.parts.values()) out.push(...p.values());
    return out;
  }

  clear(): void {
    this.parts.clear();
    this.gsi.clear();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.opts.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 500);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    const tmp = `${this.opts.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.dump()));
    renameSync(tmp, this.opts.file);
  }
}
