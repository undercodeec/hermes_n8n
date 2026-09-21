import {
  sanitizeDiagnosticSummary,
  toIncidentMetadata,
} from './hermes-diagnostics';

describe('Hermes diagnostics', () => {
  it('removes credentials and limits provider details stored in CRM metadata', () => {
    const value = `Bearer secret-token api_key=private ${'x'.repeat(700)}`;

    const result = sanitizeDiagnosticSummary(value);

    expect(result).not.toContain('secret-token');
    expect(result).not.toContain('private');
    expect(result.length).toBeLessThanOrEqual(300);
  });

  it('redacts quoted JSON credentials and prompt fields', () => {
    const result = sanitizeDiagnosticSummary(
      '{"api_key":"secret-value","token":"private-value","prompt":"internal instructions"}',
    );

    expect(result).not.toContain('secret-value');
    expect(result).not.toContain('private-value');
    expect(result).not.toContain('internal instructions');
    expect(result).toContain('[REDACTED]');
  });

  it('builds an incident without customer-visible or unsafe payload fields', () => {
    expect(
      toIncidentMetadata(
        {
          category: 'PROVIDER_ERROR',
          code: 'HERMES_PROVIDER_UNAVAILABLE',
          summary: 'HTTP 503',
          attempts: 2,
          recovered: false,
          requiresHumanReview: true,
        },
        'message-1',
        'task-1',
      ),
    ).toEqual(
      expect.objectContaining({
        category: 'PROVIDER_ERROR',
        sourceMessageId: 'message-1',
        taskId: 'task-1',
        requiresHumanReview: true,
      }),
    );
  });
});
