// Typed persistence on top of a store (MemoryStore in tests, KvsStore on Forge).
import { normalizePolicy, dayKey, hourKey } from '../policy/policy.js';
import { GateError, withExpiry, Status } from '../policy/approvals.js';
import { createHash } from 'node:crypto';

const MAX_TS = 9_999_999_999_999;
// Mutation lock: one KVS key per fixed time bucket (see withMutation).
const LOCK_PREFIX = 'mutation-lock:';
export const LOCK_BUCKET_MS = 120_000;
export const LOCK_LEASE_MS = 60_000; // > Forge's 25 s default invocation limit, < LOCK_BUCKET_MS
const actorKey = (actor) => createHash('sha256').update(actor).digest('hex');
// Dedup index per origin: agent requests keep the original key; simulations get their own, so the two never collide.
const pendingKey = (requester, fingerprint, origin) =>
  origin?.source === 'simulated' ? `pending:${requester}:${fingerprint}:sim:${origin.simulation?.mode ?? 'dry-run'}` : `pending:${requester}:${fingerprint}`;

export class Repo {
  constructor(store) {
    this.store = store;
  }

  // Installation-wide mutation lease, built only from operations Forge KVS makes atomic.
  //
  // An expired-but-unswept KVS key still blocks FAIL_IF_EXISTS for up to 48 h, and KVS has
  // no conditional delete, so a single lock key can neither expire reliably nor be taken
  // over safely. Instead each fixed time bucket has its own key:
  //   1. create this bucket's key with FAIL_IF_EXISTS (same-bucket callers exclude each other);
  //   2. read the previous and next bucket keys; if either holds a live lease, back off.
  // Two callers in adjacent buckets each write their own key and then read the other's, so
  // at least one of them sees the other and backs off. A lease (60 s) outlives any Forge
  // invocation (25 s) but not a bucket (120 s), so buckets two apart can never overlap.
  // A crashed caller blocks the gate for at most the rest of its bucket.
  async withMutation(work, nowMs = Date.now()) {
    const owner = globalThis.crypto.randomUUID();
    const bucket = Math.floor(nowMs / LOCK_BUCKET_MS);
    const key = `${LOCK_PREFIX}${bucket}`;
    const lease = { owner, expiresAt: nowMs + LOCK_LEASE_MS };
    const busy = () => new GateError('BUSY', 'another gate mutation is in progress; retry in a moment');
    if (!(await this.store.set(key, lease, { failIfExists: true, ttlSeconds: (2 * LOCK_BUCKET_MS) / 1000 }))) throw busy();
    try {
      const neighbours = await Promise.all([this.store.get(`${LOCK_PREFIX}${bucket - 1}`), this.store.get(`${LOCK_PREFIX}${bucket + 1}`)]);
      if (neighbours.some((l) => l && !(Number.isFinite(l.expiresAt) && l.expiresAt <= nowMs))) throw busy();
      return await work();
    } finally {
      // Nobody else can create this key while ours exists, so this only ever removes our lease.
      const current = await this.store.get(key);
      if (current?.owner === owner) await this.store.delete(key);
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
    // Check the complete value, including resolved Jira fields and JSON escaping.
    // Character limits alone cannot guarantee the KVS byte limit.
    if (Buffer.byteLength(JSON.stringify(req), 'utf8') >= 240 * 1024) {
      throw new GateError('REQUEST_TOO_LARGE', 'approval request must be smaller than 240 KiB; reduce the text or number of issues');
    }
    await this.store.set(`req:${req.id}`, req);
    // Index of open requests for the approval dashboard.
    const dedupKey = pendingKey(req.requester, req.fingerprint, req);
    if (req.status === Status.PENDING) {
      await this.store.set(`open:${req.id}`, req.createdAt);
      await this.store.set(dedupKey, req.id);
    } else {
      await this.store.delete(`open:${req.id}`);
      if (await this.store.get(dedupKey) === req.id) await this.store.delete(dedupKey);
    }
    // Approved simulations stay reachable from the demo panel until run, rejected or expired.
    if (req.source === 'simulated') {
      if (req.status === Status.APPROVED) await this.store.set(`simok:${req.id}`, req.id, { ttlSeconds: 8 * 86400 });
      else await this.store.delete(`simok:${req.id}`);
    } else {
      // Approved agent requests stay visible to their requester (page -> "Run it from Rovo chat") until run.
      // TTL outlives the longest approval TTL (7 days); expiry itself is decided by withExpiry, not by the TTL.
      const key = `okreq:${actorKey(req.requester)}:${req.id}`;
      if (req.status === Status.APPROVED) await this.store.set(key, req.id, { ttlSeconds: 8 * 86400 });
      else await this.store.delete(key);
    }
  }

  /** The actor's own approved, unexpired, not-yet-run agent requests (newest first). */
  async listApprovedFor(actor, limit = 20, now = Date.now()) {
    if (!actor) return [];
    const entries = await this.store.list(`okreq:${actorKey(actor)}:`, limit);
    const reqs = await Promise.all(entries.map((e) => this.getRequest(e.value)));
    return reqs
      .filter((r) => r && r.requester === actor && withExpiry(r, now).status === Status.APPROVED)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findPending(actor, fingerprint, now, origin) {
    // Point lookups are strongly consistent; KVS queries are not suitable for
    // deduplication and must never decide whether a request is authorized.
    const id = await this.store.get(pendingKey(actor, fingerprint, origin));
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

  // ---- simulated-request index for the admin demo panel (newest first) ----
  async indexSimulation(id, nowMs) {
    const inverted = String(MAX_TS - nowMs).padStart(13, '0');
    await this.store.set(`sim:${inverted}:${id}`, id, { ttlSeconds: 7 * 86400 });
  }

  /** The most recent simulations plus every still-approved one (so its Run button never disappears). */
  async listSimulations(limit = 10, now = Date.now()) {
    const [recent, approved] = await Promise.all([this.store.list('sim:', limit), this.store.list('simok:', 50)]);
    const ids = [...new Set([...recent, ...approved].map((e) => e.value))];
    const reqs = (await Promise.all(ids.map((id) => this.getRequest(id)))).filter(Boolean).map((r) => withExpiry(r, now));
    return reqs.sort((a, b) => b.createdAt - a.createdAt);
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
