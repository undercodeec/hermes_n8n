export class HermesRequestDto {
  contactName: string;
  messageContent: string;
  conversationHistory: { role: string; content: string }[];
  leadStage?: string;
  productOfInterest?: string;
  conversationSummary?: string;
}

export class HermesResponseDto {
  response: string;
  tokensUsed?: number;
  costEstimate?: number;
  suggestedTags?: string[];
  detectedIntent?: string;
  nextAction?: string;
}
