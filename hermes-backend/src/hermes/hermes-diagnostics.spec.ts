import {
  safeDiagnosticFields,
  safeProviderDiagnostic,
  sanitizeDiagnosticSummary,
  toIncidentMetadata,
} from './hermes-diagnostics';

describe('Hermes diagnostics', () => {
  it('limits generic diagnostic text and redacts recognized credentials', () => {
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
          summary: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
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
        code: 'HERMES_PROVIDER_UNAVAILABLE',
        summary: 'No se pudo completar la respuesta del proveedor.',
        sourceMessageId: 'message-1',
        taskId: 'task-1',
        requiresHumanReview: true,
      }),
    );
  });

  it('replaces provider supplied code and summary at each diagnostic boundary', () => {
    const poisoned = {
      category: 'PROVIDER_ERROR' as const,
      code: 'FAKE_PROVIDER_CODE_DO_NOT_USE',
      summary: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
      attempts: Number.POSITIVE_INFINITY,
      recovered: false,
      requiresHumanReview: true,
    };
    const fields = safeDiagnosticFields(poisoned);
    const diagnostic = safeProviderDiagnostic(poisoned);
    const incident = toIncidentMetadata(poisoned, 'synthetic-message');

    for (const output of [fields, diagnostic, incident]) {
      expect(output).toMatchObject({
        category: 'PROVIDER_ERROR',
        code: 'HERMES_PROVIDER_UNAVAILABLE',
        summary: 'No se pudo completar la respuesta del proveedor.',
      });
      expect(JSON.stringify(output)).not.toContain('FAKE_');
    }
    expect(diagnostic.attempts).toBe(0);
    expect(incident.attempts).toBe(0);
  });

  it('preserves a legitimate policy diagnostic summary', () => {
    const diagnostic = {
      category: 'POLICY_VIOLATION' as const,
      code: 'UNAUTHORIZED_PRICE',
      summary: 'Se descartó un precio sin respaldo.',
      attempts: 2,
      recovered: true,
      requiresHumanReview: false,
    };
    expect(safeProviderDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(toIncidentMetadata(diagnostic, 'synthetic-message')).toMatchObject({
      summary: diagnostic.summary,
      recovered: true,
      requiresHumanReview: false,
    });
  });

  it('keeps an internal Nous timeout code while replacing provider text', () => {
    expect(
      safeDiagnosticFields({
        category: 'PROVIDER_ERROR',
        code: 'NOUS_HERMES_TIMEOUT',
        summary: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
      }),
    ).toEqual({
      category: 'PROVIDER_ERROR',
      code: 'NOUS_HERMES_TIMEOUT',
      summary: 'No se pudo completar la respuesta del proveedor.',
    });
    expect(
      safeProviderDiagnostic({
        category: 'PROVIDER_ERROR',
        code: 'NOUS_HERMES_QUEUE_UNAVAILABLE',
        summary: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
        attempts: 0,
        recovered: false,
        requiresHumanReview: true,
      }),
    ).toMatchObject({
      code: 'NOUS_HERMES_QUEUE_UNAVAILABLE',
      summary: 'No se pudo completar la respuesta del proveedor.',
      attempts: 0,
    });
  });
});
