import { whatsappReplyWindow } from './whatsapp-service-window';

describe('whatsappReplyWindow', () => {
  const receivedAt = new Date('2026-09-20T12:00:00.000Z');

  it('is open immediately before 24 hours', () => {
    expect(
      whatsappReplyWindow(receivedAt, new Date('2026-09-21T11:59:59.999Z'))
        .isOpen,
    ).toBe(true);
  });

  it('is closed at exactly 24 hours', () => {
    expect(
      whatsappReplyWindow(receivedAt, new Date('2026-09-21T12:00:00.000Z'))
        .isOpen,
    ).toBe(false);
  });

  it('is closed without an inbound timestamp', () => {
    expect(whatsappReplyWindow(null, new Date()).isOpen).toBe(false);
  });
});
