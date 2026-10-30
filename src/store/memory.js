// In-memory store with the same interface as the Forge KVS adapter (src/store/kvs.js).
// Used by unit tests and the local demo script.
export class MemoryStore {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.expiries = new Map();
    this.map = new Map();
  }

  async get(key) {
    if (this.expiries.get(key) <= this.now()) await this.delete(key);
    const v = this.map.get(key);
    return v === undefined ? undefined : JSON.parse(v);
  }

  /** @returns {Promise<boolean>} false when failIfExists and the key exists */
  async set(key, value, { failIfExists = false, ttlSeconds } = {}) {
    if (value === null || value === undefined) throw new Error('cannot store null/undefined');
    await this.get(key);
    if (failIfExists && this.map.has(key)) return false;
    this.map.set(key, JSON.stringify(value));
    if (ttlSeconds) this.expiries.set(key, this.now() + ttlSeconds * 1000);
    else this.expiries.delete(key);
    return true;
  }

  async delete(key) {
    this.map.delete(key);
    this.expiries.delete(key);
  }

  /** Keys beginning with prefix, in lexicographic order. */
  async list(prefix, limit = 50) {
    return [...this.map.keys()]
      .filter((k) => k.startsWith(prefix) && !(this.expiries.get(k) <= this.now()))
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
