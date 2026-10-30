// Forge KVS adapter. Only imported by src/index.js (the Forge entry point), never by tests.
import { kvs, WhereConditions } from '@forge/kvs';

export class KvsStore {
  async get(key) {
    return kvs.get(key);
  }

  async set(key, value, { failIfExists = false, ttlSeconds } = {}) {
    const options = {};
    if (failIfExists) options.keyPolicy = 'FAIL_IF_EXISTS';
    if (ttlSeconds) options.ttl = { unit: 'SECONDS', value: ttlSeconds };
    try {
      await kvs.set(key, value, options);
      return true;
    } catch (err) {
      // TODO(verify on a real site): exact error code KVS raises for FAIL_IF_EXISTS conflicts.
      const code = String(err?.code ?? err?.name ?? err?.message ?? '');
      if (failIfExists && /exist|conflict|precondition/i.test(code)) return false;
      throw err;
    }
  }

  async delete(key) {
    await kvs.delete(key);
  }

  async list(prefix, limit = 50) {
    const { results } = await kvs
      .query()
      .where('key', WhereConditions.beginsWith(prefix))
      .limit(limit)
      .getMany();
    return results.map((r) => ({ key: r.key, value: r.value }));
  }
}
