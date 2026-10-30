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
    projects: { DEMO: { id: '100', key: 'DEMO' }, OPS: { id: '200', key: 'OPS' } },
  };
  for (let i = 4; i <= 40; i++) state.issues[`DEMO-${i}`] = { project: 'DEMO', status: 'To Do' };
  Object.values(state.issues).forEach((issue, i) => { issue.id ??= String(10000 + i); });
  const transitions = [
    { id: '11', name: 'Start', to: { id: '1', name: 'In Progress' } },
    { id: '21', name: 'Review', to: { id: '2', name: 'In Review' } },
    { id: '31', name: 'Finish', to: { id: '3', name: 'Done' } },
  ];
  state.transitions = transitions;
  async function request(method, path, body) {
    state.calls.push({ method, path, body });
    const m = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)(\/[a-z]+)?/);
    const ref = m ? decodeURIComponent(m[1]) : null;
    const key = state.issues[ref] ? ref : Object.keys(state.issues).find((k) => state.issues[k].id === ref);
    if (method === 'GET' && path.startsWith('/rest/api/3/project/')) {
      const project = state.projects[decodeURIComponent(path.split('/').at(-1))];
      return project ? { status: 200, data: project } : { status: 404, data: {} };
    }
    if (path.startsWith('/rest/api/3/mypermissions')) {
      return { status: 200, data: { permissions: { ADMINISTER: { havePermission: admins.includes(state.caller) } } } };
    }
    if (method === 'POST' && path === '/rest/api/3/issue') {
      const project = Object.values(state.projects).find((p) => p.id === body.fields.project.id);
      return { status: 201, data: { key: `${project.key}-999` } };
    }
    if (!key || !state.issues[key]) return { status: 404, data: { errorMessages: ['Issue does not exist'] } };
    const issue = state.issues[key];
    if (method === 'GET' && m[2] === '/transitions') return { status: 200, data: { transitions } };
    if (method === 'GET') return { status: 200, data: { id: issue.id, key: issue.key ?? key, fields: { project: { id: state.projects[issue.project]?.id, key: issue.project }, status: { name: issue.status }, summary: 's' } } };
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
  let t = Date.UTC(2026, 10, 2, 9, 0, 0);
  const store = new MemoryStore(() => t);
  const repo = new Repo(store);
  const jira = fakeJira({ admins });
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
