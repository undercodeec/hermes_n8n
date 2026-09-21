export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function whatsappReplyWindow(
  lastInboundAt: Date | null,
  now = new Date(),
) {
  const closesAt = lastInboundAt
    ? new Date(lastInboundAt.getTime() + WHATSAPP_REPLY_WINDOW_MS)
    : null;
  return {
    isOpen: Boolean(closesAt && now.getTime() < closesAt.getTime()),
    lastInboundAt,
    closesAt,
  };
}
