// Forge KVS adapter. SDK objects are injected by the Forge entry point.

export class KvsStore {
  constructor(kvs, whereConditions) {
    this.kvs = kvs;
    this.whereConditions = whereConditions;
  }

  async get(key) {
    return this.kvs.get(key);
  }

  async set(key, value, { failIfExists = false, ttlSeconds } = {}) {
    const options = {};
    if (failIfExists) options.keyPolicy = 'FAIL_IF_EXISTS';
    if (ttlSeconds) options.ttl = { unit: 'SECONDS', value: ttlSeconds };
    try {
      await this.kvs.set(key, value, options);
      return true;
    } catch (err) {
      // TODO(verify on a real site): exact error code KVS raises for FAIL_IF_EXISTS conflicts.
      const code = String(err?.code ?? err?.name ?? err?.message ?? '');
      if (failIfExists && (err?.status === 409 || err?.statusCode === 409 || /exist|conflict|precondition/i.test(code))) return false;
      throw err;
    }
  }

  async delete(key) {
    await this.kvs.delete(key);
  }

  async list(prefix, limit = 50) {
    return (await this.listPage(prefix, limit)).results;
  }

  async listPage(prefix, limit = 50, cursor) {
    let query = this.kvs
      .query()
      .where('key', this.whereConditions.beginsWith(prefix))
      .limit(limit);
    if (cursor) query = query.cursor(cursor);
    const { results, nextCursor } = await query.getMany();
    return { results: results.map((r) => ({ key: r.key, value: r.value })), nextCursor };
  }
}
