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
  /** Cantidad aproximada de productos indicada por el cliente. */
  productCount?: string;
  paymentNeeds?: string;
  shippingNeeds?: string;
  inventoryNeeds?: string;
  domainStatus?: string;
  corporateEmailNeeds?: string;
  integrations?: string;
  recommendedPlan?: string;
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

export type PaymentContext =
  'STORE_CHECKOUT' | 'PROJECT_PAYMENT' | 'UNDETERMINED';

export type ConversationGuidance = {
  /** Tema semántico del mensaje actual, calculado por el backend. */
  currentTopic: string;
  /** Una pregunta directa debe resolverse antes de continuar el descubrimiento. */
  directAnswerRequired: boolean;
  /** Indica si una pregunta comercial nueva aporta valor en este turno. */
  allowDiscoveryQuestion: boolean;
  /** El cliente dejó atrás la última pregunta del asesor y abrió otro tema. */
  topicShift: boolean;
  /** Temas de preguntas recientes del asesor para evitar repeticiones. */
  recentQuestionTopics: string[];
  /** Ya existe alcance suficiente para recomendar o solicitar una valoración. */
  sufficientContext: boolean;
  paymentContext?: PaymentContext;
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
  conversationGuidance?: ConversationGuidance;
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
