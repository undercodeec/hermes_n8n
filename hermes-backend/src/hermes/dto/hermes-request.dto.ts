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
}

export class HermesResponseDto {
  response: string;
  tokensUsed?: number;
  costEstimate?: number;
  suggestedTags?: string[];
  detectedIntent?: string;
  nextAction?: string;
  /** Datos extraídos exclusivamente de información explícita del cliente. */
  commercialProfile?: CommercialProfile;
}
