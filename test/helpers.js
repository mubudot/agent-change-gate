// Test doubles: a fake Jira transport and a ready-made service.
import { MemoryStore } from '../src/store/memory.js';
import { Repo } from '../src/store/repo.js';
import { JiraClient } from '../src/jira/client.js';
import { GateService } from '../src/service.js';

export const ALICE = 'acct-alice';
export const BOB = 'acct-bob';

export function fakeJira({ admins = [BOB], issues } = {}) {
  const state = {
    issues: issues ?? {
      'DEMO-1': { project: 'DEMO', status: 'To Do' },
      'DEMO-2': { project: 'DEMO', status: 'To Do' },
      'DEMO-3': { project: 'DEMO', status: 'In Progress' },
      'OPS-1': { project: 'OPS', status: 'To Do' },
      'MOVED-9': { project: 'OPS', status: 'To Do' }, // key prefix lies: issue now lives in OPS
    },
    calls: [],
    caller: ALICE,
    failWrites: new Set(),
  };
  for (let i = 4; i <= 40; i++) state.issues[`DEMO-${i}`] = { project: 'DEMO', status: 'To Do' };
  const transitions = [
    { id: '11', name: 'Start', to: { name: 'In Progress' } },
    { id: '21', name: 'Review', to: { name: 'In Review' } },
    { id: '31', name: 'Finish', to: { name: 'Done' } },
  ];
  async function request(method, path, body) {
    state.calls.push({ method, path, body });
    const m = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)(\/[a-z]+)?/);
    const key = m ? decodeURIComponent(m[1]) : null;
    if (path.startsWith('/rest/api/3/mypermissions')) {
      return { status: 200, data: { permissions: { ADMINISTER: { havePermission: admins.includes(state.caller) } } } };
    }
    if (method === 'POST' && path === '/rest/api/3/issue') {
      return { status: 201, data: { key: `${body.fields.project.key}-999` } };
    }
    if (!key || !state.issues[key]) return { status: 404, data: { errorMessages: ['Issue does not exist'] } };
    const issue = state.issues[key];
    if (method === 'GET' && m[2] === '/transitions') return { status: 200, data: { transitions } };
    if (method === 'GET') return { status: 200, data: { key, fields: { project: { key: issue.project }, status: { name: issue.status }, summary: 's' } } };
    if (state.failWrites.has(key)) return { status: 400, data: { errorMessages: ['boom'] } };
    if (method === 'POST' && m[2] === '/transitions') {
      issue.status = transitions.find((t) => t.id === body.transition.id).to.name;
      return { status: 204, data: null };
    }
    if (method === 'DELETE') {
      delete state.issues[key];
      return { status: 204, data: null };
    }
    return { status: method === 'POST' ? 201 : 204, data: {} };
  }
  return { state, client: new JiraClient(request) };
}

export async function setup({ policy = {}, admins } = {}) {
  const store = new MemoryStore();
  const repo = new Repo(store);
  const jira = fakeJira({ admins });
  let t = Date.UTC(2026, 10, 2, 9, 0, 0);
  let n = 0;
  const svc = new GateService({
    repo,
    jira: jira.client,
    now: () => t,
    newId: () => `id-${String(++n).padStart(6, '0')}`,
  });
  const saved = await repo.savePolicy({ allowedProjects: ['DEMO'], ...policy });
  if (!saved.ok) throw new Error(saved.errors.join('; '));
  return {
    svc, repo, store, jira,
    advance: (ms) => { t += ms; },
    as: (who) => { jira.state.caller = who; },
    writes: () => jira.state.calls.filter((c) => c.method !== 'GET'),
  };
}
