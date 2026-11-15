import { DynamoDBClient, TransactionCanceledException, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ConditionFailedError,
  TransientConflictError,
  decodeCursor,
  encodeCursor,
  type Condition,
  type Item,
  type QueryInput,
  type QueryResult,
  type TableStore,
  type TxOp,
} from './types.js';

function condExpr(c?: Condition): { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
  if (!c) return {};
  if (c.kind === 'notExists') return { ConditionExpression: 'attribute_not_exists(pk)' };
  if (c.kind === 'exists') return { ConditionExpression: 'attribute_exists(pk)' };
  if (c.kind === 'attrEquals') return { ConditionExpression: '#a = :a', ExpressionAttributeNames: { '#a': c.attr }, ExpressionAttributeValues: { ':a': c.value } };
  if (c.version === 0) {
    return { ConditionExpression: 'attribute_not_exists(pk) OR #v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': 0 } };
  }
  return { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': c.version } };
}

/** Adaptador real a Amazon DynamoDB (tabla única on-demand, cifrada, PITR). */
export class DynamoStore implements TableStore {
  readonly kind = 'dynamodb' as const;
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    const base = client ?? new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT || undefined, maxAttempts: 5 });
    this.doc = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get(pk: string, sk: string, opts?: { consistent?: boolean }): Promise<Item | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { pk, sk }, ConsistentRead: opts?.consistent ?? true }));
    const it = r.Item as Item | undefined;
    if (it?.ttl && it.ttl * 1000 < Date.now()) return undefined; // TTL aún no purgado
    return it;
  }

  async put(item: Item, condition?: Condition): Promise<void> {
    try {
      await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item, ...condExpr(condition) }));
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new ConditionFailedError('Conditional check failed', ['ConditionalCheckFailed']);
      throw e;
    }
  }

  async delete(pk: string, sk: string, condition?: Condition): Promise<void> {
    try {
      await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { pk, sk }, ...condExpr(condition) }));
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new ConditionFailedError('Conditional check failed', ['ConditionalCheckFailed']);
      throw e;
    }
  }

  async transact(ops: TxOp[]): Promise<void> {
    if (ops.length === 0) return;
    const TransactItems = ops.map((o) => {
      if (o.type === 'put') return { Put: { TableName: this.tableName, Item: o.item, ...condExpr(o.condition) } };
      if (o.type === 'delete') return { Delete: { TableName: this.tableName, Key: { pk: o.pk, sk: o.sk }, ...condExpr(o.condition) } };
      if (o.type === 'update') {
        const c = condExpr(o.condition);
        const names: Record<string, string> = { ...(c.ExpressionAttributeNames ?? {}) };
        const values: Record<string, unknown> = { ...(c.ExpressionAttributeValues ?? {}) };
        const adds = Object.entries(o.add ?? {}).map(([k, v], i) => ((names[`#u${i}`] = k), (values[`:u${i}`] = v), `#u${i} :u${i}`));
        const sets = Object.entries(o.set ?? {}).map(([k, v], i) => ((names[`#s${i}`] = k), (values[`:s${i}`] = v), `#s${i} = :s${i}`));
        const expr = [adds.length ? `ADD ${adds.join(', ')}` : '', sets.length ? `SET ${sets.join(', ')}` : ''].filter(Boolean).join(' ');
        return { Update: { TableName: this.tableName, Key: { pk: o.pk, sk: o.sk }, UpdateExpression: expr, ConditionExpression: c.ConditionExpression, ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
      }
      return { ConditionCheck: { TableName: this.tableName, Key: { pk: o.pk, sk: o.sk }, ...condExpr(o.condition) } };
    });
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: TransactItems as never }));
    } catch (e) {
      if (e instanceof TransactionCanceledException) {
        const reasons = (e.CancellationReasons ?? []).map((r) => (r.Code && r.Code !== 'None' ? r.Code : null));
        if (reasons.some((r) => r === 'ConditionalCheckFailed')) throw new ConditionFailedError('Transaction cancelled', reasons);
        if (reasons.some((r) => r === 'TransactionConflict' || r === 'ThrottlingError' || r === 'ProvisionedThroughputExceeded')) throw new TransientConflictError();
      }
      throw e;
    }
  }

  async increment(pk: string, sk: string, attr: string, opts: { max: number; ttl?: number }): Promise<number> {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk, sk },
          UpdateExpression: opts.ttl ? 'ADD #c :one SET #t = if_not_exists(#t, :ttl)' : 'ADD #c :one',
          ConditionExpression: 'attribute_not_exists(#c) OR #c < :max',
          ExpressionAttributeNames: { '#c': attr, ...(opts.ttl ? { '#t': 'ttl' } : {}) },
          ExpressionAttributeValues: { ':one': 1, ':max': opts.max, ...(opts.ttl ? { ':ttl': opts.ttl } : {}) },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return Number(r.Attributes?.[attr] ?? 0);
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new ConditionFailedError('Conditional check failed', ['ConditionalCheckFailed']);
      throw e;
    }
  }

  async query(q: QueryInput): Promise<QueryResult> {
    const index = q.index ?? 'base';
    const pkAttr = index === 'base' ? 'pk' : `${index}pk`;
    const skAttr = index === 'base' ? 'sk' : `${index}sk`;
    const names: Record<string, string> = { '#pk': pkAttr };
    const values: Record<string, unknown> = { ':pk': q.pk };
    let kce = '#pk = :pk';
    if (q.skBetween) {
      names['#sk'] = skAttr;
      values[':a'] = q.skBetween[0];
      values[':b'] = q.skBetween[1];
      kce += ' AND #sk BETWEEN :a AND :b';
    } else if (q.skBeginsWith) {
      names['#sk'] = skAttr;
      values[':p'] = q.skBeginsWith;
      kce += ' AND begins_with(#sk, :p)';
    } else if (q.skGreaterThan) {
      names['#sk'] = skAttr;
      values[':g'] = q.skGreaterThan;
      kce += ' AND #sk > :g';
    }
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: index === 'base' ? undefined : index,
        KeyConditionExpression: kce,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        Limit: q.limit ?? 100,
        ScanIndexForward: !q.descending,
        ConsistentRead: index === 'base' ? (q.consistent ?? false) : undefined,
        ExclusiveStartKey: q.cursor ? decodeCursor<Record<string, unknown>>(q.cursor) : undefined,
      }),
    );
    const now = Date.now();
    const items = ((r.Items ?? []) as Item[]).filter((i) => !(i.ttl && i.ttl * 1000 < now));
    return { items, cursor: r.LastEvaluatedKey ? encodeCursor(r.LastEvaluatedKey) : undefined };
  }
}
