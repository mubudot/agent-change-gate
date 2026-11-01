// Session progress is a cache: the gate's persisted request owns the decision
// and execution outcome. Rebuild it without approving or executing a second time.
import { outcomeOf } from '../jira/executor.js';

export async function reconcileDemoProgress(repo, session) {
  const request = session.approvalId ? await repo.getRequest(session.approvalId) : null;
  if (!request) return;
  const used = ['EXECUTING', 'EXECUTED', 'FAILED'].includes(request.status)
    || Boolean(await repo.store.get(`claim:${request.id}`));
  if (request.status !== 'APPROVED' && !used) return;

  session.results[3] = { status: 'APPROVED', approvalStatus: 'APPROVED' };
  if (session.nextStep === 3) session.nextStep = 4;
  if (!used) return;

  if (!session.results[4] || session.nextStep === 4) {
    const results = request.result?.results;
    session.results[4] = {
      approvalId: request.id,
      approvedBy: request.decidedBy,
      dryRun: request.simulation?.mode === 'dry-run',
      ...(results ? { status: outcomeOf(results).outcome, results }
        : request.status === 'EXECUTED' ? { status: 'EXECUTED' }
          : { status: 'REFUSED', code: 'ALREADY_USED', message: 'This approval was consumed. Its execution result is unavailable; it will not run again.' }),
    };
  }
  if (session.nextStep === 4) session.nextStep = 5;
}
