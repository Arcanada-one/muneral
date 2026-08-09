export class SolutionLogHeadContractError extends Error {
  public readonly code = 'SOLUTION_LOG_HEAD_CONTRACT_ERROR' as const;
  constructor(public readonly field: string, public readonly reason: string) {
    super(`Solution-log head contract violation at "${field}": ${reason}`);
    this.name = 'SolutionLogHeadContractError';
  }
}
