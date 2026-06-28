// DTOs para los payloads de webhook de Meta WhatsApp Cloud API
export class MetaWebhookDto {
  object: string;
  entry: MetaWebhookEntry[];
}

export class MetaWebhookEntry {
  id: string;
  changes: MetaWebhookChange[];
}

export class MetaWebhookChange {
  value: MetaWebhookValue;
  field: string;
}

export class MetaWebhookValue {
  messaging_product: string;
  metadata: MetaWebhookMetadata;
  contacts?: MetaWebhookContact[];
  messages?: MetaWebhookMessage[];
  statuses?: MetaWebhookStatus[];
}

export class MetaWebhookMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export class MetaWebhookContact {
  profile: { name: string };
  wa_id: string;
}

export class MetaWebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  document?: { id: string; mime_type: string; sha256: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type: string };
  video?: { id: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string; description?: string } };
  reaction?: { message_id: string; emoji: string };
  sticker?: { id: string; mime_type: string };
  context?: { from: string; id: string };
}

export class MetaWebhookStatus {
  id: string;
  status: string; // 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title: string; message: string; error_data?: { details: string } }[];
}
