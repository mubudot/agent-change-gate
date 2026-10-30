// In-memory store with the same interface as the Forge KVS adapter (src/store/kvs.js).
// Used by unit tests and the local demo script.
export class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    const v = this.map.get(key);
    return v === undefined ? undefined : JSON.parse(v);
  }

  /** @returns {Promise<boolean>} false when failIfExists and the key exists */
  async set(key, value, { failIfExists = false } = {}) {
    if (value === null || value === undefined) throw new Error('cannot store null/undefined');
    if (failIfExists && this.map.has(key)) return false;
    this.map.set(key, JSON.stringify(value));
    return true;
  }

  async delete(key) {
    this.map.delete(key);
  }

  /** Keys beginning with prefix, in lexicographic order. */
  async list(prefix, limit = 50) {
    return [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((key) => ({ key, value: JSON.parse(this.map.get(key)) }));
  }

  async listPage(prefix, limit = 50, cursor) {
    const entries = await this.list(prefix, this.map.size);
    const start = Number(cursor ?? 0);
    return {
      results: entries.slice(start, start + limit),
      nextCursor: start + limit < entries.length ? String(start + limit) : undefined,
    };
  }
}
