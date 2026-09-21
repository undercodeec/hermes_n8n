export type AutomatedDeliveryPart = {
  partIndex: number;
  content: string;
  metadata?: Record<string, unknown>;
};

export type PrepareAutomatedDeliveryBatch = {
  deliveryKind: 'HERMES_REPLY' | 'SYSTEM_NOTICE';
  conversationId: string;
  contactId: string;
  sourceMessageId: string;
  sender: 'HERMES' | 'SYSTEM';
  allowHandedOff: boolean;
  parts: AutomatedDeliveryPart[];
};

export type AutomatedDeliveryBatchResult = {
  handled: boolean;
  confirmed: number;
  terminal: boolean;
  reasonCode?: string;
};
