// Per-actor storage for the guided demo. Repo still owns locking and atomic claims;
// the prefix applies to EVERYTHING, including leases, indexes, usage and audit.
const KEY_INDEX = '__keys';
const isLease = (key) => key.startsWith('mutation-lock:');
// KVS may sweep members up to 48 hours after expiry. An extra hour also
// covers the invocation time between recording a key and writing its value.
export const MANIFEST_RETENTION_SECONDS = 49 * 3600;

export class PrefixStore {
  constructor(store, prefix, { ttlSeconds = 86400 } = {}) {
    if (!prefix || !prefix.endsWith(':')) throw new Error('a storage namespace must end with a colon');
    this.store = store;
    this.prefix = prefix;
    this.ttlSeconds = ttlSeconds;
  }

  get(key) { return this.store.get(this.prefix + key); }
  delete(key) { return this.store.delete(this.prefix + key); }

  async set(key, value, options = {}) {
    // All non-lease writes happen under this namespace's Repo mutation lease.
    // Record keys BEFORE writing: reset uses strongly consistent point reads, even
    // if KVS prefix queries have not yet caught up or a previous invocation failed.
    if (!isLease(key)) {
      const keys = await this.get(KEY_INDEX) ?? [];
      await this.store.set(this.prefix + KEY_INDEX, keys.includes(key) ? keys : [...keys, key], { ttlSeconds: this.ttlSeconds + MANIFEST_RETENTION_SECONDS });
    }
    return this.store.set(this.prefix + key, value, {
      ...options,
      ttlSeconds: Math.min(options.ttlSeconds ?? this.ttlSeconds, this.ttlSeconds),
    });
  }

  async list(prefix, limit = 50) {
    return (await this.listPage(prefix, limit)).results;
  }

  async listPage(prefix, limit = 50, cursor) {
    const page = await this.store.listPage(this.prefix + prefix, limit, cursor);
    return { ...page, results: page.results.map(({ key, value }) => ({ key: key.slice(this.prefix.length), value })) };
  }

  // Bounded point reads for views that must immediately see committed writes.
  // Audit keys sort newest first; missing (e.g. swept) members are omitted.
  async listFromManifest(prefix, limit = 50) {
    const keys = (await this.get(KEY_INDEX) ?? []).filter((key) => key.startsWith(prefix)).sort().slice(0, limit);
    const entries = await Promise.all(keys.map(async (key) => ({ key, value: await this.get(key) })));
    return entries.filter(({ value }) => value !== undefined);
  }

  // Call while holding the namespace lease. Never delete the lease itself: Repo
  // releases it in finally, so reset cannot let a concurrent mutation slip in.
  async clear() {
    const keys = await this.get(KEY_INDEX) ?? [];
    for (const key of keys) await this.delete(key);
    await this.delete(KEY_INDEX);
  }
}
