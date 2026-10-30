import test from 'node:test';
import assert from 'node:assert/strict';
import { JiraClient } from '../src/jira/client.js';
import { setup, ALICE } from './helpers.js';

test('all issue paths reject traversal, query injection and encoded escapes before transport', async () => {
  let calls = 0;
  const jira = new JiraClient(async () => { calls++; return { status: 200, data: {} }; });
  for (const key of ['.', '..', '../issue', 'DEMO-1/../2', 'DEMO-1?x=1', 'DEMO-1%2f..', 'DEMO-1#fragment']) {
    for (const operation of [
      () => jira.getIssue(key), () => jira.getTransitions(key), () => jira.addComment(key, 'fixture'),
      () => jira.transition(key, '1'), () => jira.assign(key, null), () => jira.edit(key, { summary: 'fixture' }), () => jira.remove(key),
    ]) await assert.rejects(operation(), /invalid Jira issue reference/);
  }
  assert.equal(calls, 0);
  await assert.rejects(jira.getProject('../DEMO'), /invalid Jira project key/);
  assert.equal(calls, 0);
});

test('non-success Jira reads and permission responses cannot authorize execution', async () => {
  const jira = new JiraClient(async () => ({ status: 302, data: { permissions: { ADMINISTER: { havePermission: true } } } }));
  await assert.rejects(jira.getIssue('DEMO-1'), /HTTP 302/);
  await assert.rejects(jira.getTransitions('DEMO-1'), /HTTP 302/);
  await assert.rejects(jira.getProject('DEMO'), /HTTP 302/);
  assert.equal(await jira.isJiraAdmin(), false);
});

test('missing Jira issue or project IDs cannot authorize writes', async () => {
  for (const field of ['id', 'projectId']) {
    const env = await setup();
    const get = env.jira.client.getIssue.bind(env.jira.client);
    env.jira.client.getIssue = async (key) => { const issue = await get(key); delete issue[field]; return issue; };
    assert.equal((await env.svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'fixture' }, ALICE)).status, 'INVALID');
    assert.equal(env.writes().length, 0);
  }
});
