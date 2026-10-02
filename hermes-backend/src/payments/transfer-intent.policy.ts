import { Injectable } from '@nestjs/common';

export interface TransferIntentContext {
  service?: string | null;
  amount?: number | null;
  leadOpen: boolean;
  hasApprovedTransfer: boolean;
  hasActiveAccount: boolean;
}

@Injectable()
export class TransferIntentPolicy {
  readonly version = '1';

  analyze(message: string, context: TransferIntentContext) {
    const text = message
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const evidence = text.slice(0, 200);
    const result = (approved: boolean, reason: string) => ({
      approved,
      reason,
      evidence,
      policyVersion: this.version,
    });
    if (
      /\b(no quiero|no voy|no puedo|nunca|todavia no)\b.{0,35}\b(transferir|pagar|depositar)\b/.test(
        text,
      )
    )
      return result(false, 'NEGATION');
    if (
      !/\b(cuenta|datos bancarios|datos de transferencia|transferencia|transferir|deposito)\b/.test(
        text,
      )
    )
      return result(false, 'NO_BANK_DETAILS_REQUEST');
    const requestsDetails =
      /\b(pasame|envia(?:me|nos)?|dame|facilita(?:me)?|a que cuenta|donde (?:te|les|le) (?:pago|transfiero)|voy a transferir|quiero (?:pagar|transferir))\b/.test(
        text,
      );
    const willPayNow =
      /\b(para (?:realizar|hacer|pagar|transferir)|voy a transferir|quiero (?:pagar|transferir)|(?:te|les|le) pago|anticipo|transferir hoy|pagar hoy)\b/.test(
        text,
      );
    if (!requestsDetails || !willPayNow)
      return result(false, 'NO_IMMEDIATE_PAYMENT');
    if (!context.leadOpen || context.hasApprovedTransfer)
      return result(false, 'LEAD_NOT_OPEN');
    if (!context.service || !context.amount || context.amount <= 0)
      return result(false, 'MISSING_COMMERCIAL_CONTEXT');
    if (!context.hasActiveAccount) return result(false, 'NO_ACTIVE_ACCOUNT');
    return result(true, 'APPROVED');
  }
}
