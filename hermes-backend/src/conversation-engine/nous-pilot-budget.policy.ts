import { ConfigService } from '@nestjs/config';

export type NousPilotBudgetMode = 'ENFORCE' | 'MONITOR_ONLY';

export function nousPilotBudgetMode(
  config: ConfigService,
): NousPilotBudgetMode {
  return config.get<string>('NOUS_PILOT_BUDGET_MODE', 'ENFORCE') ===
    'MONITOR_ONLY'
    ? 'MONITOR_ONLY'
    : 'ENFORCE';
}
