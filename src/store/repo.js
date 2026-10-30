// Typed persistence on top of a store (MemoryStore in tests, KvsStore on Forge).
import { normalizePolicy, dayKey, hourKey } from '../policy/policy.js';

const MAX_TS = 9_999_999_999_999;

export class Repo {
  constructor(store) {
    this.store = store;
  }

  // ---- policy ----
  async loadPolicy() {
    const raw = await this.store.get('policy');
    return normalizePolicy(raw ?? {});
  }

  async savePolicy(input) {
    const { policy, errors } = normalizePolicy(input);
    if (errors.length) return { ok: false, errors };
    await this.store.set('policy', policy);
    return { ok: true, policy };
  }

  // ---- usage counters (best effort: KVS has no atomic increment) ----
  usageKeys(actor, nowMs, timezone) {
    const day = dayKey(nowMs, timezone);
    return {
      actorHour: `usage:a:${actor}:h:${hourKey(nowMs)}`,
      actorDay: `usage:a:${actor}:d:${day}`,
      siteDay: `usage:s:d:${day}`,
    };
  }

  async getUsage(actor, nowMs, timezone) {
    const k = this.usageKeys(actor, nowMs, timezone);
    const [actorHour, actorDay, siteDay] = await Promise.all([
      this.store.get(k.actorHour),
      this.store.get(k.actorDay),
      this.store.get(k.siteDay),
    ]);
    return { actorHour: actorHour ?? 0, actorDay: actorDay ?? 0, siteDay: siteDay ?? 0 };
  }

  async addUsage(actor, nowMs, timezone, units) {
    if (units <= 0) return;
    const k = this.usageKeys(actor, nowMs, timezone);
    const u = await this.getUsage(actor, nowMs, timezone);
    await Promise.all([
      this.store.set(k.actorHour, u.actorHour + units, { ttlSeconds: 2 * 3600 }),
      this.store.set(k.actorDay, u.actorDay + units, { ttlSeconds: 2 * 86400 }),
      this.store.set(k.siteDay, u.siteDay + units, { ttlSeconds: 2 * 86400 }),
    ]);
  }

  // ---- approval requests ----
  async getRequest(id) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(id)) return undefined;
    return this.store.get(`req:${id}`);
  }

  async saveRequest(req) {
    await this.store.set(`req:${req.id}`, req);
    // Index of open requests for the approval dashboard.
    if (req.status === 'PENDING') await this.store.set(`open:${req.id}`, req.createdAt);
    else await this.store.delete(`open:${req.id}`);
  }

  async listOpenRequests(limit = 50) {
    const idx = await this.store.list('open:', limit);
    const reqs = await Promise.all(idx.map((e) => this.getRequest(e.key.slice(5))));
    return reqs.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Atomic single-use claim. Returns true for exactly one caller per request id. */
  async claimExecution(id, actor, nowMs) {
    return this.store.set(`claim:${id}`, { actor, at: nowMs }, { failIfExists: true });
  }

  // ---- audit log (newest first by key order) ----
  async appendAudit(entry) {
    const inverted = String(MAX_TS - entry.at).padStart(13, '0');
    const key = `audit:${inverted}:${entry.id}`;
    await this.store.set(key, entry, { ttlSeconds: 90 * 86400 });
    await this.store.set(`auditu:${entry.actor}:${inverted}:${entry.id}`, entry, { ttlSeconds: 90 * 86400 });
  }

  async listAudit(limit = 50) {
    return (await this.store.list('audit:', limit)).map((e) => e.value);
  }

  async listAuditForActor(actor, limit = 20) {
    return (await this.store.list(`auditu:${actor}:`, limit)).map((e) => e.value);
  }
}
