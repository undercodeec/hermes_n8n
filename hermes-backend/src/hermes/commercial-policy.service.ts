import { Injectable } from '@nestjs/common';

export type PendingQuestion =
  | 'price'
  | 'timeline'
  | 'proposal'
  | 'availability';

export type CommercialPolicyDecision = {
  intent?: string;
  pendingQuestions: PendingQuestion[];
  requestsHuman: boolean;
  requestsCall: boolean;
  requestedCallAt?: Date;
  hasRelativeCallTime: boolean;
};

@Injectable()
export class CommercialPolicyService {
  analyze(
    content: string,
    receivedAt: Date,
    previousPending: string[] = [],
  ): CommercialPolicyDecision {
    const normalized = this.normalize(content);
    const pending = new Set<PendingQuestion>(
      previousPending.filter((value): value is PendingQuestion =>
        ['price', 'timeline', 'proposal', 'availability'].includes(value),
      ),
    );

    if (/\b(cuanto (cuesta|vale)|precio|coste|costo|cotiz)/.test(normalized)) {
      pending.add('price');
    }
    if (
      /\b(cuanto (tarda|demora)|plazo|tiempo de entrega|para cuando)/.test(
        normalized,
      )
    ) {
      pending.add('timeline');
    }
    if (/\b(propuesta|presupuesto formal)/.test(normalized)) {
      pending.add('proposal');
    }

    const requestsHuman = this.matches(normalized, [
      /\b(hablar|conversar|comunicarme) con (una persona|alguien|un humano|un asesor|un comercial)\b/,
      /\b(asesor|agente|persona) (real|humano)\b/,
    ]);
    const requestsCall = this.matches(normalized, [
      /\b(llamada|llamarme|llamenme|me llamen|hablar por telefono)\b/,
      /\b(puede[n]? llamar|podemos hablar)\b/,
    ]);
    const relativeMinutes = this.relativeMinutes(normalized);
    const hasRelativeCallTime = relativeMinutes !== undefined;
    const requestedCallAt = hasRelativeCallTime
      ? new Date(receivedAt.getTime() + relativeMinutes * 60_000)
      : undefined;

    return {
      intent: requestsHuman
        ? 'solicitud_humano'
        : requestsCall || hasRelativeCallTime
          ? 'agendar_cita'
          : pending.has('price')
            ? 'consulta_precio'
            : undefined,
      pendingQuestions: [...pending],
      requestsHuman,
      requestsCall: requestsCall || hasRelativeCallTime,
      requestedCallAt,
      hasRelativeCallTime,
    };
  }

  remainingPendingQuestions(
    pending: PendingQuestion[],
    response: string,
  ): PendingQuestion[] {
    const normalized = this.normalize(response);
    const hasAuthorizedValue =
      /\b\d[\d.,]*\s*(?:eur|euros?|usd|dolares?)\b|[€$]\s*\d/.test(normalized);
    const explainsPriceEscalation =
      /\b(?:no (?:dispongo|tenemos)|sin)\b.{0,60}\b(?:precio|tarifa|cifra)\b.{0,80}\b(?:confirm\w*|autoriz\w*|cotiz\w*|valoracion)\b/.test(
        normalized,
      ) ||
      /\b(?:precio|tarifa|cifra)\b.{0,80}\b(?:requiere|necesita|sujeto a)\b.{0,40}\b(?:cotiz\w*|valoracion|revision)\b/.test(
        normalized,
      );
    const hasTimeline =
      /\b\d+\s*(?:dias?|semanas?|meses?)\b/.test(normalized) ||
      /\b(?:plazo|tiempo de entrega)\b.{0,80}\b(?:requiere|necesita|sujeto a|sin)\b.{0,40}\b(?:valoracion|revision|confirmacion)\b/.test(
        normalized,
      );
    return pending.filter((question) => {
      if (question === 'price')
        return !(hasAuthorizedValue || explainsPriceEscalation);
      if (question === 'timeline') return !hasTimeline;
      return true;
    });
  }

  private relativeMinutes(value: string): number | undefined {
    const match = value.match(
      /\b(?:en|dentro de)\s+(\d{1,3}|diez|quince|veinte|treinta|cuarenta y cinco|una)\s+(minuto|minutos|hora|horas)\b/,
    );
    if (!match) return undefined;
    const words: Record<string, number> = {
      una: 1,
      diez: 10,
      quince: 15,
      veinte: 20,
      treinta: 30,
      'cuarenta y cinco': 45,
    };
    const amount = /^\d+$/.test(match[1]) ? Number(match[1]) : words[match[1]];
    if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
    return match[2].startsWith('hora') ? amount * 60 : amount;
  }

  private matches(value: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(value));
  }

  private normalize(value: string): string {
    return value
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
