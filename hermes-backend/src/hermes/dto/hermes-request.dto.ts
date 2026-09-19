export type CommercialProfile = {
  service?: string;
  company?: string;
  sector?: string;
  location?: string;
  /** Variante detectada con evidencia; NEUTRAL cuando aún no se puede determinar. */
  languageVariant?: 'ES' | 'LATAM' | 'NEUTRAL';
  need?: string;
  currentSituation?: string;
  users?: string;
  budget?: string;
  timeline?: string;
  nextStep?: string;
  /** Preguntas expresas del cliente que todavía requieren respuesta. */
  pendingQuestions?: Array<'price' | 'timeline' | 'proposal' | 'availability'>;
  contactPreference?: 'WHATSAPP' | 'CALL' | 'VIDEO_CALL' | 'EMAIL';
  requestedContactTime?: string;
  lastObjection?: string;
  /** Solo es una sugerencia: el backend decide si la transición es válida. */
  suggestedStage?: 'CONTACTED' | 'QUALIFIED';
};

export class HermesRequestDto {
  contactName: string;
  messageContent: string;
  conversationHistory: { role: string; content: string }[];
  leadStage?: string;
  productOfInterest?: string;
  conversationSummary?: string;
  /** Ficha persistida de mensajes anteriores; no depende del historial completo. */
  commercialProfile?: CommercialProfile;
  contact?: {
    id: string;
    /** Indica que WhatsApp ya proporciona un número utilizable; no se expone en el prompt. */
    hasUsablePhone: boolean;
    hasEmail: boolean;
  };
  conversationId?: string;
  currentIntent?: string;
  pendingQuestions?: string[];
  contactPreference?: string;
  pendingActions?: Array<{
    type: string;
    status: string;
    dueAt?: string;
  }>;
  actionCapabilities?: {
    callbackTasks: boolean;
    calendarBooking: boolean;
    humanHandoff: boolean;
  };
}

export class HermesResponseDto {
  response: string;
  tokensUsed?: number;
  costEstimate?: number;
  suggestedTags?: string[];
  detectedIntent?: string;
  nextAction?: string;
  decision?: string;
  /** Datos extraídos exclusivamente de información explícita del cliente. */
  commercialProfile?: CommercialProfile;
}
