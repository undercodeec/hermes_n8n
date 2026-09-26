export interface CalendarSlot {
  start: string;
  end: string;
}
export interface AvailabilityRequest {
  from: string;
  to: string;
  excludeEventId?: string;
}
export interface CalendarPolicy {
  timezone: string;
  durationMinutes: number;
  bufferMinutes: number;
  businessStart: string;
  businessEnd: string;
  businessDays: number[];
}
export interface CalendarConfig extends CalendarPolicy {
  enabled: boolean;
  calendarId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
}
export interface MeetingTurn {
  conversationId: string;
  contactId: string;
  sourceMessageId: string;
  text: string;
  now: Date;
  serviceContext?: string;
}
export interface MeetingReply {
  handled: boolean;
  content?: string;
  meetingId?: string;
  errorCode?: string;
}
export interface MeetingDraft {
  meetingId: string;
  eventId: string;
  calendarId: string;
  slot: CalendarSlot;
  timezone: string;
  email: string;
  serviceContext?: string;
}
