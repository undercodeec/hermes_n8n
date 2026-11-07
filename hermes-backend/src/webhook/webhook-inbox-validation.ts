import { normalizeWhatsAppId } from '../campaigns/phone-normalizer';
import {
  MetaWebhookContact,
  MetaWebhookMessage,
  MetaWebhookStatus,
} from './dto/meta-webhook.dto';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type ValidMessage = {
  message: MetaWebhookMessage;
  contact: MetaWebhookContact;
  phoneNumberId: string;
};

type Validation<T> =
  | { value: T; reason?: never }
  | { value?: never; reason: string };

function validOptionalStrings(
  owner: Record<string, unknown>,
  field: string,
  names: readonly string[],
): boolean {
  const nested = owner[field];
  if (nested === undefined) return true;
  if (!isRecord(nested)) return false;
  return names.every(
    (name) => nested[name] === undefined || typeof nested[name] === 'string',
  );
}

function validRequiredStrings(
  owner: Record<string, unknown>,
  field: string,
  names: readonly string[],
): boolean {
  const nested = owner[field];
  return (
    isRecord(nested) &&
    names.every(
      (name) => typeof nested[name] === 'string' && !!nested[name].trim(),
    )
  );
}

/** Check the stored JSON before any contact, commercial, or delivery side effect. */
export function validateInboxMessage(
  payload: unknown,
): Validation<ValidMessage> {
  if (!isRecord(payload)) return { reason: 'PAYLOAD_NOT_OBJECT' };
  if (!isRecord(payload.message)) return { reason: 'MESSAGE_NOT_OBJECT' };
  const message = payload.message;
  if (typeof message.id !== 'string' || !message.id.trim())
    return { reason: 'MESSAGE_ID_INVALID' };
  if (typeof message.from !== 'string' || !message.from.trim())
    return { reason: 'MESSAGE_FROM_MISSING' };
  const sender = normalizeWhatsAppId(message.from);
  if (!sender) return { reason: 'MESSAGE_FROM_INVALID' };
  if (typeof message.type !== 'string' || !message.type.trim())
    return { reason: 'MESSAGE_TYPE_INVALID' };
  if (message.timestamp !== undefined && typeof message.timestamp !== 'string')
    return { reason: 'MESSAGE_TIMESTAMP_INVALID' };
  if (!isRecord(payload.contact)) return { reason: 'CONTACT_NOT_OBJECT' };
  const contact = payload.contact;
  if (typeof contact.wa_id !== 'string' || !contact.wa_id.trim())
    return { reason: 'CONTACT_WA_ID_MISSING' };
  const contactId = normalizeWhatsAppId(contact.wa_id);
  if (!contactId || contactId !== sender)
    return { reason: 'CONTACT_WA_ID_INVALID' };
  if (contact.profile !== undefined && !isRecord(contact.profile))
    return { reason: 'CONTACT_PROFILE_INVALID' };
  const profile = isRecord(contact.profile) ? contact.profile : {};
  if (profile.name !== undefined && typeof profile.name !== 'string')
    return { reason: 'CONTACT_PROFILE_NAME_INVALID' };
  if (
    typeof payload.phoneNumberId !== 'string' ||
    !payload.phoneNumberId.trim()
  )
    return { reason: 'PHONE_NUMBER_ID_INVALID' };

  const nestedStrings: Array<[string, readonly string[]]> = [
    ['text', ['body']],
    ['image', ['id', 'mime_type', 'sha256', 'caption']],
    ['document', ['id', 'mime_type', 'sha256', 'filename', 'caption']],
    ['audio', ['id', 'mime_type', 'sha256']],
    ['video', ['id', 'mime_type']],
    ['sticker', ['id', 'mime_type']],
    ['reaction', ['message_id', 'emoji']],
    ['context', ['from', 'id']],
    ['referral', ['source_type', 'source_id', 'ctwa_clid']],
    ['interactive', ['type']],
  ];
  for (const [field, names] of nestedStrings) {
    if (!validOptionalStrings(message, field, names))
      return { reason: `MESSAGE_${field.toUpperCase()}_INVALID` };
  }
  if (message.type === 'text' && !isRecord(message.text))
    return { reason: 'MESSAGE_TEXT_INVALID' };
  if (
    message.type === 'text' &&
    typeof (message.text as Record<string, unknown>).body !== 'string'
  )
    return { reason: 'MESSAGE_TEXT_BODY_INVALID' };
  const requiredByType: Record<string, readonly string[]> = {
    image: ['id', 'mime_type'],
    document: ['id', 'mime_type'],
    audio: ['id', 'mime_type'],
    video: ['id', 'mime_type'],
    sticker: ['id', 'mime_type'],
    reaction: ['message_id'],
    interactive: ['type'],
  };
  const required = requiredByType[message.type];
  if (required && !validRequiredStrings(message, message.type, required))
    return { reason: `MESSAGE_${message.type.toUpperCase()}_INVALID` };
  if (isRecord(message.audio)) {
    if (
      message.audio.voice !== undefined &&
      typeof message.audio.voice !== 'boolean'
    )
      return { reason: 'MESSAGE_AUDIO_INVALID' };
    if (
      message.audio.duration !== undefined &&
      (typeof message.audio.duration !== 'number' ||
        !Number.isFinite(message.audio.duration))
    )
      return { reason: 'MESSAGE_AUDIO_INVALID' };
  }
  if (isRecord(message.interactive)) {
    for (const field of ['button_reply', 'list_reply'] as const) {
      if (
        !validOptionalStrings(message.interactive, field, [
          'id',
          'title',
          'description',
        ])
      )
        return { reason: 'MESSAGE_INTERACTIVE_REPLY_INVALID' };
    }
    const replyType = message.interactive.type;
    if (
      (replyType === 'button_reply' || replyType === 'list_reply') &&
      !validRequiredStrings(message.interactive, replyType, ['id', 'title'])
    )
      return { reason: 'MESSAGE_INTERACTIVE_REPLY_INVALID' };
  }
  if (message.location !== undefined) {
    if (!isRecord(message.location))
      return { reason: 'MESSAGE_LOCATION_INVALID' };
    const location = message.location;
    for (const field of ['latitude', 'longitude'] as const) {
      if (
        location[field] !== undefined &&
        (typeof location[field] !== 'number' ||
          !Number.isFinite(location[field]))
      )
        return { reason: 'MESSAGE_LOCATION_INVALID' };
    }
    if (
      !['name', 'address'].every(
        (field) =>
          location[field] === undefined || typeof location[field] === 'string',
      )
    )
      return { reason: 'MESSAGE_LOCATION_INVALID' };
  }
  if (
    message.type === 'location' &&
    (!isRecord(message.location) ||
      typeof message.location.latitude !== 'number' ||
      !Number.isFinite(message.location.latitude) ||
      typeof message.location.longitude !== 'number' ||
      !Number.isFinite(message.location.longitude))
  )
    return { reason: 'MESSAGE_LOCATION_INVALID' };

  return {
    value: {
      message: message as unknown as MetaWebhookMessage,
      contact: {
        ...(contact as unknown as MetaWebhookContact),
        profile: { name: typeof profile.name === 'string' ? profile.name : '' },
      },
      phoneNumberId: payload.phoneNumberId,
    },
  };
}

export function validateInboxStatus(payload: unknown): Validation<{
  status: MetaWebhookStatus;
  phoneNumberId: string;
}> {
  if (!isRecord(payload)) return { reason: 'PAYLOAD_NOT_OBJECT' };
  if (!isRecord(payload.status)) return { reason: 'STATUS_NOT_OBJECT' };
  if (typeof payload.status.id !== 'string' || !payload.status.id.trim())
    return { reason: 'STATUS_ID_INVALID' };
  if (
    typeof payload.status.status !== 'string' ||
    !payload.status.status.trim()
  )
    return { reason: 'STATUS_VALUE_INVALID' };
  if (
    typeof payload.phoneNumberId !== 'string' ||
    !payload.phoneNumberId.trim()
  )
    return { reason: 'PHONE_NUMBER_ID_INVALID' };
  return {
    value: {
      status: payload.status as unknown as MetaWebhookStatus,
      phoneNumberId: payload.phoneNumberId,
    },
  };
}
