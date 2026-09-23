import { Injectable } from '@nestjs/common';
import {
  CommercialProfile,
  ConversationGuidance,
  HermesResponseDto,
  PaymentContext,
} from './dto/hermes-request.dto';
import { normalizeCommonSpanishTypos } from './spanish-text-normalizer';

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
  guidance: ConversationGuidance;
};

type PolicyContext = {
  conversationHistory?: Array<{ role: string; content: string }>;
  commercialProfile?: CommercialProfile;
};

@Injectable()
export class CommercialPolicyService {
  /** Conserva información válida y retira condiciones que la instantánea CRM no respalda. */
  repairNousCommercialClaims(
    response: string,
    approvedKnowledge: string[],
    hasActivePromotion = false,
  ): { response: string; reasons: string[] } {
    const catalog = this.normalize(approvedKnowledge.join(' '));
    const catalogWords = new Set(catalog.match(/[a-z0-9]{3,}/g) ?? []);
    const stopWords = new Set([
      'con',
      'para',
      'por',
      'del',
      'las',
      'los',
      'una',
      'uno',
      'que',
      'tambien',
      'todos',
      'todas',
      'hasta',
      'plan',
      'servicio',
      'servicios',
    ]);
    const reasons: string[] = [];
    const sentences = response.split(/(?<=[.!?])\s+/u).filter(Boolean);
    const kept = sentences.filter((sentence) => {
      const normalized = this.normalize(sentence);
      const unsupportedOffer =
        /\b(?:gratis|gratuito|sin costo|de por vida|ilimitad\w*)\b/.test(
          normalized,
        ) ||
        (/\b(?:descuento|rebaja|promocion)\b/.test(normalized) &&
          (!hasActivePromotion || /\b\d+(?:[.,]\d+)?\s*%/.test(normalized)));
      if (unsupportedOffer) {
        reasons.push('UNAUTHORIZED_DISCOUNT');
        return false;
      }
      if (
        /\b(?:entrega|entregado|listo|terminado|implementado|plazo)\b.{0,70}\b\d+\s*(?:dias?|semanas?|meses?)\b|\b\d+\s*(?:dias?|semanas?|meses?)\b.{0,70}\b(?:entrega|listo|terminado|implementado)\b/.test(
          normalized,
        ) ||
        /\b(?:entrega(?:mos|remos)?|entregado|lista|listo|terminado|implementado|plazo|tarda|demora)\b.{0,70}\b(?:\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|diez|quince|treinta)(?:\s*(?:a|y|-)\s*\d+)?\s*(?:horas?|dias?|semanas?|meses?)\b|\b(?:entrega(?:mos|remos)?|lista|listo)\b.{0,40}\b(?:manana|proxima semana)\b/.test(
          normalized,
        )
      ) {
        reasons.push('UNAUTHORIZED_TIMELINE');
        return false;
      }
      if (
        /\b(?:cuotas?|anticipo|abono|financiacion|50\s*\/\s*50|pago[s]?\s+(?:a|en)\s+plazos?)\b/.test(
          normalized,
        )
      ) {
        reasons.push('UNAUTHORIZED_PAYMENT_TERMS');
        return false;
      }
      const inclusion = normalized.match(
        /\b(?:incluye|incluido|contiene|viene con)\b\s+(.+)/,
      );
      if (inclusion) {
        const features = (inclusion[1].match(/[a-z0-9]{3,}/g) ?? []).filter(
          (word) => !stopWords.has(word),
        );
        if (!catalog || features.some((word) => !catalogWords.has(word))) {
          reasons.push('UNAUTHORIZED_INCLUSION');
          return false;
        }
      }
      return true;
    });
    return {
      response:
        kept.join(' ').trim() ||
        'Este punto requiere una valoración del equipo antes de confirmar condiciones.',
      reasons,
    };
  }

  analyze(
    content: string,
    receivedAt: Date,
    previousPending: string[] = [],
    context: PolicyContext = {},
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

    const requestsHuman =
      !/\b(?:no quiero|no necesito|no deseo|sin)\b.{0,40}\b(?:hablar|conversar|comunicarme)\b.{0,30}\b(?:persona|humano|asesor|agente)\b/.test(
        normalized,
      ) &&
      this.matches(normalized, [
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
    const paymentContext = this.paymentContext(normalized);
    const clarificationRequest = this.isClarificationRequest(normalized);
    const currentTopic = clarificationRequest
      ? 'clarification'
      : this.currentTopic(normalized, paymentContext);
    const recentQuestionTopics = this.recentQuestionTopics(
      context.conversationHistory || [],
    );
    const previousQuestionTopic = recentQuestionTopics.at(-1);
    const directAnswerRequired = [
      'price',
      'timeline',
      'infrastructure',
      'renewal',
      'store_payment',
      'project_payment',
      'technical_explanation',
      'plan_details',
      'business_location',
      'clarification',
    ].includes(currentTopic);
    const topicShift = Boolean(
      previousQuestionTopic &&
      currentTopic !== 'general' &&
      currentTopic !== previousQuestionTopic &&
      !this.looksLikeAnswerTo(normalized, previousQuestionTopic),
    );
    const sufficientContext = this.hasSufficientContext(
      context.commercialProfile,
      normalized,
      context.conversationHistory || [],
    );
    const commercialScope = this.normalize(
      [
        context.commercialProfile?.service,
        context.commercialProfile?.need,
        content,
      ]
        .filter(Boolean)
        .join(' '),
    );
    const complexValuation =
      (sufficientContext &&
        /\b(?:software a medida|sistema personalizado|integracion(?:es)?|automatizacion(?:es)?|aplicacion movil)\b/.test(
          commercialScope,
        )) ||
      (/\b(?:software a medida|sistema personalizado)\b/.test(normalized) &&
        /\b(?:integrado|integracion(?:es)?|inventario|automatizacion(?:es)?)\b/.test(
          normalized,
        ) &&
        /\b(?:equipo|usuarios?|socios?|personal|bodega|ventas?)\b/.test(
          normalized,
        ));
    const priceAnswerRequired =
      currentTopic === 'price' || pending.has('price');
    // The worker replaces this with the current CRM authority snapshot.
    const allowPriceAnswer = false;
    const requiredClarification = this.requiresCatalogClarification(
      normalized,
      context.conversationHistory || [],
      context.commercialProfile,
    )
      ? 'CATALOG_VS_ONLINE_SALES'
      : undefined;
    const allowMeetingOffer =
      requestsCall ||
      complexValuation ||
      /\b(?:reunion|asesor(?:a|ia)?|especialista|videollamada|llamada)\b/.test(
        normalized,
      );
    const interestedPlan = this.interestedPlan(
      normalized,
      context.conversationHistory || [],
    );
    const allowPlanRecommendation =
      !clarificationRequest &&
      !requiredClarification &&
      (Boolean(interestedPlan) ||
        this.hasPlanRecommendationBasis(
          normalized,
          context.conversationHistory || [],
          context.commercialProfile,
          sufficientContext,
        ));
    const allowPlanDetails = !clarificationRequest && Boolean(interestedPlan);
    const offerWebAlternatives =
      !clarificationRequest &&
      !interestedPlan &&
      /\b(?:sitio web|pagina web|desarrollo web|presencia (?:web|en internet))\b/.test(
        commercialScope,
      ) &&
      /\b(?:promocionar|promocion|presencia|servicios|economico|economica|barato|barata|alternativa|opciones?)\b/.test(
        commercialScope,
      );
    const allowDiscoveryQuestion =
      !clarificationRequest &&
      !requestsHuman &&
      !(requestsCall || hasRelativeCallTime) &&
      !directAnswerRequired &&
      !topicShift &&
      (!sufficientContext || Boolean(requiredClarification));

    return {
      intent: requestsHuman
        ? 'solicitud_humano'
        : requestsCall || hasRelativeCallTime
          ? 'agendar_cita'
          : paymentContext === 'PROJECT_PAYMENT'
            ? 'consulta_pago_proyecto'
            : paymentContext === 'STORE_CHECKOUT'
              ? 'consulta_cobro_tienda'
              : pending.has('price')
                ? 'consulta_precio'
                : undefined,
      pendingQuestions: [...pending],
      requestsHuman,
      requestsCall: requestsCall || hasRelativeCallTime,
      requestedCallAt,
      hasRelativeCallTime,
      guidance: {
        currentTopic,
        directAnswerRequired,
        allowDiscoveryQuestion,
        topicShift,
        recentQuestionTopics,
        sufficientContext,
        ...(requiredClarification ? { requiredClarification } : {}),
        allowMeetingOffer,
        allowPlanRecommendation,
        allowPriceAnswer,
        priceAnswerRequired,
        allowPlanDetails,
        ...(interestedPlan ? { interestedPlan } : {}),
        offerWebAlternatives,
        ...(paymentContext ? { paymentContext } : {}),
      },
    };
  }

  enforceResponsePolicy(
    response: HermesResponseDto,
    decision: CommercialPolicyDecision,
  ): HermesResponseDto {
    if (decision.guidance.requiredClarification === 'CATALOG_VS_ONLINE_SALES') {
      const profile = { ...response.commercialProfile };
      delete profile.recommendedPlan;
      delete profile.paymentNeeds;
      if (
        profile.service &&
        /\b(?:tienda online|ecommerce|comercio electronico)\b/.test(
          this.normalize(profile.service),
        )
      ) {
        delete profile.service;
      }
      profile.need =
        'Mostrar productos en internet; falta confirmar catálogo o venta online';
      return {
        ...response,
        response:
          'Para recomendarle la solución adecuada, necesito confirmar una diferencia importante: ¿desea que sus clientes solamente vean el catálogo o que también puedan comprar y pagar directamente en la página?',
        detectedIntent: 'consulta_servicio',
        nextAction: 'continuar_descubrimiento',
        suggestedTags: undefined,
        commercialProfile: profile,
      };
    }

    let content = this.enforceQuestionPolicy(response.response, decision);
    if (!decision.guidance.allowMeetingOffer) {
      content = this.stripUnrequestedMeetingOffer(content, decision);
    }
    const commercialProfile = { ...response.commercialProfile };
    if (
      decision.guidance.offerWebAlternatives &&
      !decision.guidance.interestedPlan
    ) {
      delete commercialProfile.recommendedPlan;
    }
    return {
      ...response,
      response: content,
      ...(response.commercialProfile ? { commercialProfile } : {}),
      ...(!decision.guidance.allowMeetingOffer &&
      ['proponer_reunion', 'solicitar_confirmacion_reunion'].includes(
        response.nextAction || '',
      )
        ? { nextAction: 'sin_accion' }
        : {}),
    };
  }

  enforceQuestionPolicy(
    response: string,
    decision: CommercialPolicyDecision,
  ): string {
    const questions = response.match(/¿[^?]{2,300}\?/gu) || [];
    if (!questions.length) return response;

    const blocked = new Set<string>();
    for (const question of questions) {
      const topic = this.questionTopic(this.normalize(question));
      const repeatsRecentTopic =
        topic !== 'general' &&
        decision.guidance.recentQuestionTopics.includes(topic);
      const isDiscovery = this.isDiscoveryTopic(topic);
      if (
        repeatsRecentTopic ||
        (!decision.guidance.allowDiscoveryQuestion && isDiscovery)
      ) {
        blocked.add(question);
      }
    }
    if (!blocked.size) return response;

    const filtered = [...blocked]
      .reduce((text, question) => text.replace(question, ''), response)
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return filtered || this.safePolicyContinuation(decision);
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

  private paymentContext(value: string): PaymentContext | undefined {
    const projectPayment = this.matches(value, [
      /\b(?:50\s*\/\s*50|50\s*%[^.]{0,35}50\s*%)\b/,
      /\b(?:anticipo|abono inicial|entrada|cuotas?|saldo)\b.{0,70}\b(?:proyecto|plan|servicio|desarrollo|entrega|contrato)\b/,
      /\b(?:pagar|pago|financiar)\b.{0,45}\b(?:proyecto|plan|servicio|desarrollo|ustedes|undercode)\b/,
      /\b(?:proyecto|plan|servicio|desarrollo)\b.{0,45}\b(?:pagar|pago|anticipo|cuotas?|saldo)\b/,
    ]);
    if (projectPayment) return 'PROJECT_PAYMENT';

    const storePayment = this.matches(value, [
      /\b(?:mis clientes|compradores?|usuarios?)\b.{0,65}\b(?:pagar|pagos?|tarjeta|transferencia|paypal|stripe|pasarela)\b/,
      /\b(?:pasarela|checkout|carrito|cobrar online|pago seguro)\b/,
      /\b(?:tarjetas?|transferencias?|paypal|stripe)\b.{0,55}\b(?:tienda|web|compras?|clientes?)\b/,
      /\b(?:tienda|web|compras?|clientes?)\b.{0,55}\b(?:tarjetas?|transferencias?|paypal|stripe|pagar)\b/,
    ]);
    if (storePayment) return 'STORE_CHECKOUT';
    if (
      /\b(?:forma|metodo|opcion) de pago\b|\bcomo (?:se )?paga\b/.test(value)
    ) {
      return 'UNDETERMINED';
    }
    return undefined;
  }

  private requiresCatalogClarification(
    current: string,
    history: Array<{ role: string; content: string }>,
    profile?: CommercialProfile,
  ): boolean {
    const customerHistory = history
      .filter((message) => message.role !== 'assistant')
      .map((message) => this.normalize(message.content));
    const discoveryEvidence = [
      ...customerHistory,
      current,
      this.normalize(profile?.need || ''),
    ].join(' ');
    const wantsProductsVisible =
      /\b(?:ver|mostrar|exhibir|publicar|catalogo)\b.{0,45}\bproductos?\b/.test(
        discoveryEvidence,
      ) ||
      /\bproductos?\b.{0,45}\b(?:ver|mostrar|exhibir|publicar|catalogo)\b/.test(
        discoveryEvidence,
      ) ||
      /\b(?:ver|mostrar|exhibir|publicar)\b.{0,35}\bcatalogo\b/.test(
        discoveryEvidence,
      );
    if (!wantsProductsVisible) return false;

    const customerEvidence = [...customerHistory, current].join(' ');
    return !this.matches(customerEvidence, [
      /\b(?:vender|comprar|cobrar|pagar|pago)\b.{0,45}\b(?:online|linea|pagina|web|tienda|productos?)\b/,
      /\b(?:online|linea|pagina|web|tienda|productos?)\b.{0,45}\b(?:vender|comprar|cobrar|pagar|pago)\b/,
      /\b(?:solo|unicamente)\b.{0,35}\b(?:catalogo|mostrar|exhibir|ver)\b/,
      /\b(?:catalogo|mostrar|exhibir|ver)\b.{0,35}\b(?:sin pagos?|sin vender|solamente|unicamente)\b/,
    ]);
  }

  private stripUnrequestedMeetingOffer(
    response: string,
    decision: CommercialPolicyDecision,
  ): string {
    const parts = response.match(/[^.!?¿]+(?:[.!?]|$)/gu) || [response];
    const filtered = parts.filter((part) => {
      const normalized = this.normalize(part);
      if (/^(?:no\b|sin necesidad de\b|no hace falta\b)/.test(normalized)) {
        return true;
      }
      return !/\b(?:coordinar|agendar|programar)\b.{0,70}\b(?:reunion|llamada|conversacion)\b|\b(?:reunion|llamada|conversacion)\b.{0,70}\b(?:equipo|asesor|especialista)\b|\b(?:asesor|especialista)\b.{0,70}\b(?:revisar|contactar|conversar|propuesta)\b/i.test(
        normalized,
      );
    });
    const content = filtered
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return content || this.safePolicyContinuation(decision);
  }

  private safePolicyContinuation(decision: CommercialPolicyDecision): string {
    return decision.guidance.sufficientContext
      ? 'Con la información disponible ya podemos avanzar con la recomendación o valoración correspondiente.'
      : 'Gracias por la información. Podemos continuar con su solicitud.';
  }

  private hasPlanRecommendationBasis(
    current: string,
    history: Array<{ role: string; content: string }>,
    profile: CommercialProfile | undefined,
    sufficientContext: boolean,
  ): boolean {
    const customerEvidence = [
      ...history
        .filter((message) => message.role !== 'assistant')
        .map((message) => this.normalize(message.content)),
      current,
      this.normalize(profile?.service || ''),
      this.normalize(profile?.need || ''),
      this.normalize(profile?.productCount || ''),
      this.normalize(profile?.paymentNeeds || ''),
      this.normalize(profile?.shippingNeeds || ''),
      this.normalize(profile?.inventoryNeeds || ''),
      this.normalize(profile?.corporateEmailNeeds || ''),
    ].join(' ');
    const isStore =
      /\b(?:tienda online|ecommerce|comercio electronico|carrito|checkout|vender online|venta online|cobrar online|pagar online)\b/.test(
        customerEvidence,
      );
    if (!isStore) return sufficientContext;

    const hasProductVolume =
      Boolean(profile?.productCount) ||
      /\b\d+(?:\s*(?:a|-|hasta)\s*\d+)?\s*(?:productos?|articulos?)\b/.test(
        customerEvidence,
      );
    const hasSecondStoreRequirement =
      Boolean(
        profile?.paymentNeeds ||
        profile?.shippingNeeds ||
        profile?.inventoryNeeds ||
        profile?.corporateEmailNeeds,
      ) ||
      /\b(?:cobrar|pagar|pagos?|tarjeta|transferencia|paypal|stripe|pasarela|envios?|entregas?|inventario|stock|correos? corporativos?)\b/.test(
        customerEvidence,
      );
    return hasProductVolume && hasSecondStoreRequirement;
  }

  private interestedPlan(
    current: string,
    history: Array<{ role: string; content: string }>,
  ): 'LANDING_PAGE' | 'WEBSITE' | 'ONLINE_STORE' | undefined {
    const asksForDetails =
      /\b(?:que (?:(?:no )?mas |nomas )?(?:incluye|trae|contiene|viene)|de que.{0,20}viene|que viene incluido|detalles|mas informacion|expliqueme|cuenteme mas|como funciona)\b/.test(
        current,
      );
    const selectsOption =
      /\b(?:me interesa|estoy interesado|prefiero|elijo|escojo|quiero conocer|quiero saber mas|me quedo con)\b/.test(
        current,
      );
    if (!asksForDetails && !selectsOption) return undefined;

    const explicit = this.singlePlanInText(current);
    if (explicit) return explicit;
    const lastAssistant = [...history]
      .reverse()
      .find((message) => message.role === 'assistant');
    if (lastAssistant) {
      const selectedAmount = current.match(
        /(?:[$€]\s*|\b(?:usd|eur)\s*)(\d[\d.,]*)/,
      );
      if (selectedAmount) {
        const prior = this.normalize(lastAssistant.content);
        const selectedPrice = selectedAmount[0].replace(/[.,]+$/, '');
        const priceAt = prior.indexOf(selectedPrice);
        if (priceAt >= 0) {
          const nearby = prior.slice(Math.max(0, priceAt - 60), priceAt);
          const plan = this.singlePlanInText(nearby);
          if (plan) return plan;
        }
      }
    }
    if (!asksForDetails) return undefined;
    return lastAssistant
      ? this.singlePlanInText(this.normalize(lastAssistant.content))
      : undefined;
  }

  private singlePlanInText(
    value: string,
  ): 'LANDING_PAGE' | 'WEBSITE' | 'ONLINE_STORE' | undefined {
    const plans: Array<'LANDING_PAGE' | 'WEBSITE' | 'ONLINE_STORE'> = [];
    if (/\b(?:landing|pagina de aterrizaje)\b/.test(value))
      plans.push('LANDING_PAGE');
    if (
      /\b(?:plan de lanzamiento|plan de crecimiento|plan de autoridad|sitio web|pagina web)\b/.test(
        value,
      )
    )
      plans.push('WEBSITE');
    if (/\b(?:tienda online|ecommerce|tienda de)\b/.test(value))
      plans.push('ONLINE_STORE');
    return plans.length === 1 ? plans[0] : undefined;
  }

  private currentTopic(value: string, paymentContext?: PaymentContext): string {
    if (paymentContext === 'PROJECT_PAYMENT') return 'project_payment';
    if (paymentContext === 'STORE_CHECKOUT') return 'store_payment';
    if (this.isOrganizationLocationQuestion(value)) return 'business_location';
    if (
      /\b(?:renovacion|renovar|segundo ano|despues del primer ano)\b/.test(
        value,
      )
    )
      return 'renewal';
    if (/\b(?:hosting|dominio|ssl|https|correo corporativo)\b/.test(value))
      return 'infrastructure';
    if (/\b(?:cuanto (?:cuesta|vale)|precio|coste|costo|cotiz)\b/.test(value))
      return 'price';
    if (
      /\b(?:cuanto (?:tarda|demora)|plazo|tiempo de entrega|para cuando)\b/.test(
        value,
      )
    )
      return 'timeline';
    if (/\b(?:que es|como funciona|que significa|para que sirve)\b/.test(value))
      return 'technical_explanation';
    if (
      /\b(?:que (?:(?:no )?mas |nomas )?(?:incluye|trae|contiene|viene)|de que.{0,20}viene|que viene incluido|detalles|mas informacion)\b/.test(
        value,
      )
    )
      return 'plan_details';
    if (/\b(?:catalogo|ver|mostrar)\b.{0,35}\bproductos?\b/.test(value))
      return 'store_goal';
    return 'general';
  }

  private isClarificationRequest(value: string): boolean {
    return (
      /^[?¿!¡.\s]+$/.test(value) ||
      /^(?:no entend[íi]|no comprendo|c[oó]mo|qu[eé]|perd[oó]n)(?:[?¿!¡.\s]+)?$/.test(
        value,
      ) ||
      /\b(?:no entiendo|no comprendo|que quiere decir|eso que tiene que ver)\b/.test(
        value,
      )
    );
  }

  private recentQuestionTopics(
    history: Array<{ role: string; content: string }>,
  ): string[] {
    const topics = history
      .slice(-12)
      .filter(
        (message) =>
          message.role === 'assistant' && /[?¿]/.test(message.content),
      )
      .map((message) => this.questionTopic(this.normalize(message.content)))
      .filter((topic) => topic !== 'general');
    return topics.slice(-6);
  }

  private questionTopic(value: string): string {
    if (
      /\b(?:forma|metodo|medio|pasarela).{0,30}\b(?:pago|cobro)|\bcomo.{0,25}cobrar/.test(
        value,
      )
    )
      return 'store_payment';
    if (/\bcuantos?.{0,15}productos?\b/.test(value)) return 'product_count';
    if (/\b(?:envios?|entregas?|zonas?)\b/.test(value)) return 'shipping';
    if (/\b(?:inventario|stock)\b/.test(value)) return 'inventory';
    if (/\b(?:dominio|hosting)\b/.test(value)) return 'domain';
    if (/\b(?:presupuesto|inversion)\b/.test(value)) return 'budget';
    if (/\b(?:plazo|cuando|tiempo)\b/.test(value)) return 'timeline';
    if (/\b(?:correo|email)\b/.test(value)) return 'email';
    if (/\b(?:telefono|numero|whatsapp)\b/.test(value)) return 'phone';
    if (
      /\b(?:que|cual).{0,25}(?:tipo de )?(?:proyecto|servicio|solucion)\b/.test(
        value,
      )
    )
      return 'service';
    if (/\b(?:a que se dedica|actividad|sector|negocio)\b/.test(value))
      return 'business';
    if (/\b(?:objetivo|lograr|conseguir|necesita)\b/.test(value)) return 'goal';
    if (/\b(?:vender online|comprar|catalogo)\b/.test(value))
      return 'store_goal';
    return 'general';
  }

  private isDiscoveryTopic(topic: string): boolean {
    return [
      'store_payment',
      'product_count',
      'shipping',
      'inventory',
      'domain',
      'budget',
      'timeline',
      'email',
      'phone',
      'service',
      'business',
      'goal',
      'store_goal',
    ].includes(topic);
  }

  private looksLikeAnswerTo(value: string, topic: string): boolean {
    const patterns: Record<string, RegExp> = {
      store_payment:
        /\b(?:tarjeta|transferencia|paypal|stripe|efectivo|contra entrega|aun no|todavia no)\b/,
      product_count: /\b\d+\s*(?:productos?|articulos?)\b/,
      shipping: /\b(?:envio|entrega|nacional|local|ciudad|provincia|pais)\b/,
      inventory: /\b(?:inventario|stock|existencias)\b/,
      domain: /\b(?:dominio|hosting|ya tengo|no tengo)\b/,
      budget: /\b(?:usd|dolares?|euros?|presupuesto|no se|aun no)\b|[$€]\s*\d/,
      timeline:
        /\b\d+\s*(?:dias?|semanas?|meses?)\b|\b(?:urgente|sin prisa|fecha)\b/,
      business:
        /\b(?:vendo|venta|ofrezco|reparo|reparacion|reparaciones|servicio|restaurante|floristeria|consultoria|asesoria|abogado|comercio|tienda|empresa|negocio|nos dedicamos a)\b/,
      goal: /\b(?:quiero|necesito|busco|objetivo|para)\b/,
    };
    return patterns[topic]?.test(value) ?? false;
  }

  private hasSufficientContext(
    profile: CommercialProfile | undefined,
    current: string,
    history: Array<{ role: string; content: string }>,
  ): boolean {
    if (!profile?.service || !profile.need) return false;
    const persistedEvidence = Boolean(
      profile.sector ||
      profile.company ||
      profile.currentSituation ||
      profile.users ||
      profile.productCount ||
      profile.paymentNeeds ||
      profile.shippingNeeds ||
      profile.inventoryNeeds ||
      profile.integrations ||
      profile.timeline ||
      profile.location,
    );
    if (persistedEvidence) return true;

    const latestAssistantQuestion = [...history]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' && /[?¿]/.test(message.content),
      );
    if (!latestAssistantQuestion) return false;

    const topic = this.questionTopic(
      this.normalize(latestAssistantQuestion.content),
    );
    if (
      topic === 'business' &&
      /\b(?:no tengo|no hay|sin|ningun[oa]?)\b.{0,30}\b(?:negocio|empresa|actividad|servicio|sector)\b/.test(
        current,
      )
    ) {
      return false;
    }
    if (topic === 'general' || !this.looksLikeAnswerTo(current, topic)) {
      return false;
    }

    const stopWords = new Set([
      'a',
      'de',
      'el',
      'en',
      'la',
      'las',
      'los',
      'mi',
      'un',
      'una',
      'y',
    ]);
    const meaningfulTokens = (current.match(/\b[a-z]{2,}\b/g) || []).filter(
      (token) => !stopWords.has(token),
    );
    return meaningfulTokens.length >= 2;
  }

  private isOrganizationLocationQuestion(value: string): boolean {
    if (
      /\bdonde estan(?: ubicad[oa]s?)?\b|\bdesde donde (?:trabaja[n]?|opera[n]?|atiende[n]?)\b/.test(
        value,
      )
    ) {
      return true;
    }
    if (/\b(?:tienen|cuentan con|hay)\b.{0,25}\bsede\b/.test(value)) {
      return true;
    }
    if (
      /\b(?:direccion (?:fisica )?(?:exacta)?|como llegar)\b/.test(value) &&
      /\b(?:undercodeec|ustedes|su sede|su oficina)\b/.test(value)
    ) {
      return true;
    }
    return (
      /\b(?:undercodeec|ustedes)\b.{0,45}\b(?:ubicacion|ubicad[oa]s?|pais|ciudad|sede)\b/.test(
        value,
      ) ||
      /\b(?:ubicacion|ubicad[oa]s?|pais|ciudad|sede)\b.{0,45}\b(?:undercodeec|ustedes)\b/.test(
        value,
      )
    );
  }

  private matches(value: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(value));
  }

  private normalize(value: string): string {
    const normalized = value
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return normalizeCommonSpanishTypos(normalized);
  }
}
