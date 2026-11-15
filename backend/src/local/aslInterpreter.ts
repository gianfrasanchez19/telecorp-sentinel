/**
 * INTÉRPRETE ASL LOCAL (EMULADOR — NO equivale a AWS Step Functions).
 * Ejecuta la MISMA definición JSON que se despliega en AWS, con el subconjunto
 * usado por el proyecto: Task, Choice, Map (INLINE), Pass, Succeed, Fail,
 * Parameters/ItemSelector, ResultPath, Retry (con backoff escalado) y Catch.
 */
type Json = any;

export interface ExecutionRecord {
  name: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  input: Json;
  output?: Json;
  error?: { Error: string; Cause: string };
  startedAt: string;
  stoppedAt?: string;
  events: { at: string; state: string; type: string; detail?: string }[];
}

export class StatesError extends Error {
  constructor(
    public readonly error: string,
    public override readonly cause: string,
  ) {
    super(`${error}: ${cause}`);
    this.name = error;
  }
}

function getPath(obj: Json, path: string, ctx: Json): Json {
  if (path === '$') return obj;
  if (path.startsWith('$$.')) return walk(ctx, path.slice(3));
  if (!path.startsWith('$.')) throw new StatesError('States.Runtime', `Ruta no soportada ${path}`);
  return walk(obj, path.slice(2));
}

function walk(obj: Json, rest: string): Json {
  let cur = obj;
  for (const seg of rest.split('.')) {
    const m = /^([^[]+)((\[\d+\])*)$/.exec(seg);
    if (!m) throw new StatesError('States.Runtime', `Segmento inválido ${seg}`);
    cur = cur?.[m[1]];
    for (const idx of m[2].match(/\d+/g) ?? []) cur = cur?.[Number(idx)];
  }
  return cur;
}

function hasPath(obj: Json, path: string): boolean {
  try {
    return getPath(obj, path, {}) !== undefined;
  } catch {
    return false;
  }
}

function applyParams(tpl: Json, input: Json, ctx: Json): Json {
  if (Array.isArray(tpl)) return tpl.map((t) => applyParams(t, input, ctx));
  if (tpl && typeof tpl === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(tpl)) {
      if (k.endsWith('.$')) {
        const val = getPath(input, v as string, ctx);
        if (val === undefined) throw new StatesError('States.Runtime', `La ruta ${v} no existe en la entrada`);
        out[k.slice(0, -2)] = val;
      } else out[k] = applyParams(v, input, ctx);
    }
    return out;
  }
  return tpl;
}

function setResult(input: Json, resultPath: string | null | undefined, result: Json): Json {
  if (resultPath === undefined || resultPath === '$') return result;
  if (resultPath === null) return input;
  const segs = resultPath.slice(2).split('.');
  const out = structuredClone(input ?? {});
  let cur = out;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]] ??= {};
  cur[segs[segs.length - 1]] = result;
  return out;
}

function matchesError(list: string[], name: string): boolean {
  return list.includes(name) || (list.includes('States.ALL') && name !== 'States.Runtime') || (name === 'States.Runtime' && list.includes('States.Runtime'));
}

function evalChoice(rule: Json, input: Json): boolean {
  if (rule.And) return rule.And.every((r: Json) => evalChoice(r, input));
  if (rule.Or) return rule.Or.some((r: Json) => evalChoice(r, input));
  if (rule.Not) return !evalChoice(rule.Not, input);
  const v = hasPath(input, rule.Variable) ? getPath(input, rule.Variable, {}) : undefined;
  if ('IsPresent' in rule) return (v !== undefined) === rule.IsPresent;
  if ('StringEquals' in rule) return v === rule.StringEquals;
  if ('BooleanEquals' in rule) return v === rule.BooleanEquals;
  if ('NumericEquals' in rule) return v === rule.NumericEquals;
  if ('NumericGreaterThan' in rule) return typeof v === 'number' && v > rule.NumericGreaterThan;
  if ('NumericGreaterThanEquals' in rule) return typeof v === 'number' && v >= rule.NumericGreaterThanEquals;
  throw new StatesError('States.Runtime', `Operador Choice no soportado: ${JSON.stringify(rule)}`);
}

export type TaskResolver = (resource: string) => (input: Json) => Promise<Json>;

export class AslInterpreter {
  constructor(
    private readonly definition: Json,
    private readonly resolve: TaskResolver,
    private readonly opts: { retryDelayScale?: number } = {},
  ) {}

  async run(name: string, input: Json, rec: ExecutionRecord): Promise<Json> {
    return this.runMachine(this.definition, input, rec, {});
  }

  private async runMachine(def: Json, input: Json, rec: ExecutionRecord, ctx: Json): Promise<Json> {
    let stateName: string = def.StartAt;
    let data = input;
    for (let steps = 0; steps < 500; steps++) {
      const st = def.States[stateName];
      if (!st) throw new StatesError('States.Runtime', `Estado ${stateName} no existe`);
      rec.events.push({ at: new Date().toISOString(), state: stateName, type: `${st.Type}StateEntered` });
      try {
        switch (st.Type) {
          case 'Pass': {
            const res = 'Result' in st ? st.Result : st.Parameters ? applyParams(st.Parameters, data, ctx) : data;
            data = setResult(data, st.ResultPath, res);
            break;
          }
          case 'Succeed':
            return data;
          case 'Fail':
            throw new StatesError(st.Error ?? 'States.Fail', st.Cause ?? '');
          case 'Choice': {
            const hit = (st.Choices as Json[]).find((c) => evalChoice(c, data));
            const next = hit?.Next ?? st.Default;
            if (!next) throw new StatesError('States.NoChoiceMatched', stateName);
            stateName = next;
            continue;
          }
          case 'Task': {
            const effective = st.Parameters ? applyParams(st.Parameters, data, ctx) : data;
            const fn = this.resolve(st.Resource);
            const res = await this.withRetry(st, rec, stateName, () => fn(structuredClone(effective)));
            data = setResult(data, st.ResultPath, res);
            break;
          }
          case 'Map': {
            const items = getPath(data, st.ItemsPath ?? '$', ctx) as Json[];
            if (!Array.isArray(items)) throw new StatesError('States.Runtime', 'ItemsPath no es un arreglo');
            const proc = st.ItemProcessor ?? st.Iterator;
            const results: Json[] = [];
            for (let i = 0; i < items.length; i++) {
              const itemCtx = { Map: { Item: { Index: i, Value: items[i] } } };
              const itemInput = st.ItemSelector ? applyParams(st.ItemSelector, data, itemCtx) : items[i];
              results.push(await this.runMachine(proc, itemInput, rec, itemCtx));
            }
            data = setResult(data, st.ResultPath, results);
            break;
          }
          default:
            throw new StatesError('States.Runtime', `Tipo ${st.Type} no soportado`);
        }
      } catch (e) {
        const err = e instanceof StatesError ? e : new StatesError((e as Error).name || 'Error', JSON.stringify({ errorMessage: (e as Error).message, errorType: (e as Error).name }));
        rec.events.push({ at: new Date().toISOString(), state: stateName, type: 'StateFailed', detail: err.error });
        const c = (st.Catch as Json[] | undefined)?.find((x) => matchesError(x.ErrorEquals, err.error));
        if (!c) throw err;
        data = setResult(data, c.ResultPath, { Error: err.error, Cause: err.cause });
        stateName = c.Next;
        continue;
      }
      if (st.End) return data;
      stateName = st.Next;
    }
    throw new StatesError('States.Runtime', 'Demasiadas transiciones');
  }

  private async withRetry(st: Json, rec: ExecutionRecord, stateName: string, fn: () => Promise<Json>): Promise<Json> {
    const counters = new Map<number, number>();
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        const name = (e as Error).name || 'Error';
        const idx = ((st.Retry as Json[]) ?? []).findIndex((r) => matchesError(r.ErrorEquals, name));
        if (idx < 0) throw e;
        const r = st.Retry[idx];
        const n = counters.get(idx) ?? 0;
        if (n >= (r.MaxAttempts ?? 3)) throw e;
        counters.set(idx, n + 1);
        const delay = Math.min((r.IntervalSeconds ?? 1) * (r.BackoffRate ?? 2) ** n, r.MaxDelaySeconds ?? 3600) * 1000 * (this.opts.retryDelayScale ?? 0.01);
        rec.events.push({ at: new Date().toISOString(), state: stateName, type: 'TaskRetry', detail: `${name} intento ${n + 1}` });
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
}
