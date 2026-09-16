export const AUTO_REPLY_QUEUE = 'automatic-whatsapp-replies';

export interface AutoReplyJobData {
  conversationId: string;
  contactId: string;
  inboundMessageId: string;
}
