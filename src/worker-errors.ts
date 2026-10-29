import { UnrecoverableError } from 'bullmq';
import type { Database } from './database.js';
export class ResearchTerminalFailure extends UnrecoverableError {
  constructor(message: string) { super(message); }
}
export function researchProcessor(research: { execute(runId:string):Promise<void> }, db: Pick<Database,'researchRun'>) {
  return async (job: {data:{runId:string}}) => {
    await research.execute(job.data.runId);
    const run=await db.researchRun.findUniqueOrThrow({where:{id:job.data.runId}});
    if(run.status==='FAILED')throw new ResearchTerminalFailure(run.error||'Research failed');
  };
}
