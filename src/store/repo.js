// Typed persistence on top of a store (MemoryStore in tests, KvsStore on Forge).
import { normalizePolicy, dayKey, hourKey } from '../policy/policy.js';
import { GateError, withExpiry, Status } from '../policy/approvals.js';
import { createHash } from 'node:crypto';

const MAX_TS = 9_999_999_999_999;
const actorKey = (actor) => createHash('sha256').update(actor).digest('hex');

export class Repo {
  constructor(store) {
    this.store = store;
  }

  // No TTL: an expired lease could let a suspended invocation resume alongside
  // a new owner. A terminated invocation instead leaves the gate closed until
  // an operator has confirmed it stopped and removed this key.
  async withMutation(work) {
    if (!(await this.store.set('mutation-lock', { held: true }, { failIfExists: true }))) {
      throw new GateError('BUSY', 'another gate mutation is in progress; retry later');
    }
    try {
      return await work();
    } finally {
      await this.store.delete('mutation-lock');
    }
  }

  // ---- policy ----
  async loadPolicy() {
    const raw = await this.store.get('policy');
    return normalizePolicy(raw === undefined ? {} : raw);
  }

  async savePolicy(input) {
    const { policy, errors } = normalizePolicy(input);
    if (errors.length) return { ok: false, errors };
    await this.store.set('policy', policy);
    return { ok: true, policy };
  }

  // ---- usage reservations (call only while holding the mutation lock) ----
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
    const count = (v) => v === undefined ? 0 : v;
    const usage = { actorHour: count(actorHour), actorDay: count(actorDay), siteDay: count(siteDay) };
    for (const value of Object.values(usage)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new GateError('USAGE_INVALID', 'stored usage is invalid; writes are blocked');
    }
    return usage;
  }

  async addUsage(actor, nowMs, timezone, units) {
    if (units <= 0) return;
    const k = this.usageKeys(actor, nowMs, timezone);
    const u = await this.getUsage(actor, nowMs, timezone);
    // Finish each write before releasing the lock, even if a later write fails.
    // Failures may overcount attempts, but cannot grant uncounted Jira writes.
    await this.store.set(k.actorHour, u.actorHour + units, { ttlSeconds: 2 * 3600 });
    await this.store.set(k.actorDay, u.actorDay + units, { ttlSeconds: 2 * 86400 });
    await this.store.set(k.siteDay, u.siteDay + units, { ttlSeconds: 2 * 86400 });
  }

  // ---- approval requests ----
  async getRequest(id) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(id)) return undefined;
    return this.store.get(`req:${id}`);
  }

  async saveRequest(req) {
    await this.store.set(`req:${req.id}`, req);
    // Index of open requests for the approval dashboard.
    const pendingKey = `pending:${req.requester}:${req.fingerprint}`;
    if (req.status === Status.PENDING) {
      await this.store.set(`open:${req.id}`, req.createdAt);
      await this.store.set(pendingKey, req.id);
    } else {
      await this.store.delete(`open:${req.id}`);
      if (await this.store.get(pendingKey) === req.id) await this.store.delete(pendingKey);
    }
  }

  async findPending(actor, fingerprint, now) {
    // Point lookups are strongly consistent; KVS queries are not suitable for
    // deduplication and must never decide whether a request is authorized.
    const id = await this.store.get(`pending:${actor}:${fingerprint}`);
    const req = await this.getRequest(id);
    return req && withExpiry(req, now).status === Status.PENDING ? req : undefined;
  }

  async listOpenRequests(limit = 50, now = Date.now(), actor) {
    const visible = [];
    let cursor;
    do {
      const page = await this.store.listPage('open:', 50, cursor);
      const reqs = await Promise.all(page.results.map((e) => this.getRequest(e.key.slice(5))));
      for (const req of reqs) {
        if (req && withExpiry(req, now).status === Status.PENDING && (!actor || req.requester === actor)) visible.push(req);
      }
      cursor = page.nextCursor;
    } while (cursor && visible.length < limit);
    return visible.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
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
    await this.store.set(`auditu:${actorKey(entry.actor)}:${inverted}:${entry.id}`, entry, { ttlSeconds: 90 * 86400 });
  }

  async listAudit(limit = 50) {
    return (await this.store.list('audit:', limit)).map((e) => e.value);
  }

  async listAuditForActor(actor, limit = 20) {
    return (await this.store.list(`auditu:${actorKey(actor)}:`, limit)).map((e) => e.value);
  }
}
