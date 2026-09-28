import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Meeting, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GoogleCalendarService } from './google-calendar.service';
import { MeetingOperationsService } from './meeting-operations.service';
import { CalendarError } from './calendar.errors';
import {
  CalendarSlot,
  MeetingReply,
  MeetingTurn,
  AvailabilityRequest,
} from './calendar.types';
import { generateSlots, validRange, localParts } from './slot-engine';
import { normalizeMeetingText, parseMeetingDate } from './meeting-date-parser';
import {
  MeetingLocation,
  readMeetingLocation,
  resolveMeetingLocation,
  meetingPolicy,
  meetingTimeLabel,
  meetingDualTime,
  mentionsMeetingLocation,
} from './meeting-region';

const PAGE_SIZE = 12;
const LOCATION_QUESTION =
  'Para mostrarle los horarios correctos, ¿en qué ciudad y país se encuentra? Atendemos reuniones para Ecuador y España. Si está en España, puede indicar también si es península/Baleares o Canarias.';

interface MeetingState {
  phase:
    | 'AWAITING_LOCATION'
    | 'AWAITING_DATE'
    | 'OFFERING'
    | 'AWAITING_EMAIL'
    | 'BOOKING'
    | 'CONFIRMED'
    | 'AWAITING_CANCEL_CONFIRMATION'
    | 'AWAITING_RESCHEDULE_CONFIRMATION'
    | 'AWAITING_MEETING_SELECTION'
    | 'CANCELLED';
  mode: 'CREATE' | 'RESCHEDULE';
  attemptId: string;
  slots: CalendarSlot[];
  range?: AvailabilityRequest;
  selected?: CalendarSlot;
  email?: string;
  meetingId?: string;
  operationId?: string;
  serviceContext?: string;
  meetingChoices?: string[];
  cancelChoice?: boolean;
  timezone?: string;
  location?: MeetingLocation;
  pageOffset?: number;
  requestedText?: string;
  requestedAt?: string;
}
const emailPattern =
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+\b/i;
export function isMeetingRequest(text: string): boolean {
  const s = normalizeMeetingText(text);
  return (
    /\b(?:reunion|reunirnos|reunir|meet|videollamada|video llamada|videoconferencia|reprogramar)\b/.test(
      s,
    ) ||
    /\b(?:agendar|programar|reservar)\b.{0,30}\b(?:llamada|cita|reunion)\b/.test(
      s,
    ) ||
    /^(?:quiero |quisiera |podemos )?agendar[.!]?$/.test(s)
  );
}
function readState(value: unknown): MeetingState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const v = value as MeetingState;
  if (
    ![
      'AWAITING_LOCATION',
      'AWAITING_DATE',
      'OFFERING',
      'AWAITING_EMAIL',
      'BOOKING',
      'CONFIRMED',
      'AWAITING_CANCEL_CONFIRMATION',
      'AWAITING_RESCHEDULE_CONFIRMATION',
      'AWAITING_MEETING_SELECTION',
      'CANCELLED',
    ].includes(v.phase) ||
    !['CREATE', 'RESCHEDULE'].includes(v.mode) ||
    typeof v.attemptId !== 'string' ||
    !Array.isArray(v.slots) ||
    v.slots.length > 3100 ||
    v.slots.some((s) => !validRange({ from: s.start, to: s.end }))
  )
    return undefined;
  if (v.selected && !validRange({ from: v.selected.start, to: v.selected.end }))
    return undefined;
  if (v.timezone !== undefined) {
    if (typeof v.timezone !== 'string') return undefined;
    try {
      new Intl.DateTimeFormat('es', { timeZone: v.timezone }).format();
    } catch {
      return undefined;
    }
  }
  if (
    v.pageOffset !== undefined &&
    (!Number.isInteger(v.pageOffset) ||
      v.pageOffset < 0 ||
      v.pageOffset > v.slots.length)
  )
    return undefined;
  return v;
}
@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleCalendarService,
    private readonly operations: MeetingOperationsService,
  ) {}
  async interrupt(conversationId: string): Promise<void> {
    await this.operations.interrupt(conversationId);
  }
  private async save(turn: MeetingTurn, state: MeetingState): Promise<void> {
    const json = JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${turn.conversationId}))`;
      await tx.conversationState.upsert({
        where: { conversationId: turn.conversationId },
        create: { conversationId: turn.conversationId, meetingState: json },
        update: { meetingState: json },
      });
    });
  }
  private label(
    slot: CalendarSlot,
    timezone = this.google.config.timezone,
  ): string {
    return meetingTimeLabel(slot, timezone);
  }
  private confirmation(meeting: Meeting): MeetingReply {
    if (meeting.status === 'CANCELLED')
      return {
        handled: true,
        meetingId: meeting.id,
        content:
          'Su reunión quedó cancelada. La invitación del calendario fue actualizada.',
      };
    if (meeting.status !== 'CONFIRMED' || !meeting.meetUrl)
      throw new CalendarError('MEETING_OPERATION_PENDING', true);
    return {
      handled: true,
      meetingId: meeting.id,
      content: `Listo. Su reunión quedó agendada para ${meetingDualTime({ start: meeting.startAt.toISOString(), end: meeting.endAt.toISOString() }, meeting.timezone)}. Le envié la invitación al correo indicado. Puede ingresar por Google Meet aquí: ${meeting.meetUrl}`,
    };
  }
  private async active(turn: MeetingTurn): Promise<Meeting[]> {
    return this.prisma.meeting.findMany({
      where: {
        conversationId: turn.conversationId,
        contactId: turn.contactId,
        status: 'CONFIRMED',
        startAt: { gt: turn.now },
      },
      orderBy: { startAt: 'asc' },
      take: 4,
    });
  }
  private async offer(
    turn: MeetingTurn,
    state: MeetingState,
    range?: AvailabilityRequest,
    prefix = '',
  ): Promise<MeetingReply> {
    if (!state.timezone) {
      await this.save(turn, {
        ...state,
        phase: 'AWAITING_LOCATION',
        slots: [],
        selected: undefined,
      });
      return { handled: true, content: LOCATION_QUESTION };
    }
    const actual = range ??
      state.range ?? {
        from: turn.now.toISOString(),
        to: new Date(turn.now.getTime() + 7 * 86400000).toISOString(),
      };
    if (!validRange(actual) || Date.parse(actual.to) <= turn.now.getTime())
      return {
        handled: true,
        content: '¿Qué fecha y hora futuras le vienen bien para la reunión?',
      };
    const busy = await this.google.getAvailability({
      ...actual,
      excludeEventId: state.meetingId
        ? (
            await this.prisma.meeting.findUnique({
              where: { id: state.meetingId },
            })
          )?.googleEventId
        : undefined,
    });
    const local = await this.operations.localBusy(
      actual.from,
      actual.to,
      state.meetingId,
    );
    const all = generateSlots(
      actual,
      [...busy, ...local],
      meetingPolicy(this.google.config, state.timezone),
      turn.now,
    );
    state = {
      ...state,
      phase: 'OFFERING',
      range: actual,
      slots: all,
      pageOffset: 0,
      selected: undefined,
      operationId: undefined,
    };
    await this.save(turn, state);
    if (!all.length)
      return {
        handled: true,
        content:
          'No encontré horarios disponibles en ese rango. ¿Qué otro día le viene bien?',
      };
    return this.page(state, prefix);
  }
  private page(state: MeetingState, prefix = ''): MeetingReply {
    const offset = state.pageOffset ?? 0;
    const page = state.slots.slice(offset, offset + PAGE_SIZE);
    const timezone = state.timezone ?? this.google.config.timezone;
    const more = offset + PAGE_SIZE < state.slots.length;
    return {
      handled: true,
      content: `${prefix}Horarios disponibles (${timezone}), reuniones de ${this.google.config.durationMinutes} minutos:\n${page.map((s, i) => `${offset + i + 1}. ${this.label(s, timezone)}`).join('\n')}\n¿Cuál le queda mejor? Puede indicar el número o la hora.${more ? '\nEscriba «ver más horarios» para consultar los siguientes.' : ''}${offset ? '\nEscriba «horarios anteriores» para volver.' : ''}\nTambién puede pedir otro día.`,
    };
  }
  private async rememberLocation(
    turn: MeetingTurn,
    location: MeetingLocation,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact:${turn.contactId}`}))`;
      const contact = await tx.contact.findUniqueOrThrow({
        where: { id: turn.contactId },
        select: { metadata: true },
      });
      const metadata =
        contact.metadata &&
        typeof contact.metadata === 'object' &&
        !Array.isArray(contact.metadata)
          ? contact.metadata
          : {};
      await tx.contact.update({
        where: { id: turn.contactId },
        data: {
          metadata: { ...metadata, schedulingLocation: { ...location } },
        },
      });
    });
  }
  private async beginDate(
    turn: MeetingTurn,
    state: MeetingState,
    text: string,
    referenceNow = turn.now,
  ): Promise<MeetingReply> {
    const timezone = state.timezone!;
    const date = parseMeetingDate(text, referenceNow, timezone);
    if (date.ambiguous) {
      const day = parseMeetingDate(
        text.replace(
          /\b(?:a las?|despues de las?|desde las?)\s+\d{1,2}(?::\d{2})?(?:\s*(?:de la tarde|de la manana|de la noche|am|pm))?/gi,
          '',
        ),
        referenceNow,
        timezone,
      );
      await this.save(turn, {
        ...state,
        phase: 'OFFERING',
        range: day.range,
        slots: [],
      });
      return {
        handled: true,
        content:
          '¿Puede indicar la fecha y hora, aclarando si es por la mañana o por la tarde?',
      };
    }
    if (!date.range) {
      await this.save(turn, { ...state, phase: 'AWAITING_DATE' });
      return {
        handled: true,
        content: `¿Qué día le viene bien para la reunión? Le mostraré todos los horarios libres en su hora local (${timezone}).`,
      };
    }
    return this.offer(turn, state, date.range);
  }
  private async book(
    turn: MeetingTurn,
    state: MeetingState,
    kind: 'CREATE' | 'RESCHEDULE' | 'CANCEL' = state.mode,
  ): Promise<MeetingReply> {
    if (!state.selected || !state.email)
      throw new CalendarError('GOOGLE_CALENDAR_EVENT_CREATE_FAILED');
    if (!state.operationId) {
      const operation = await this.operations.prepare(
        kind,
        {
          ...turn,
          serviceContext: state.serviceContext ?? turn.serviceContext,
        },
        {
          key: `${state.attemptId}:${kind}`,
          slot: state.selected,
          email: state.email,
          meetingId: kind === 'CREATE' ? undefined : state.meetingId,
          timezone: state.timezone,
        },
      );
      state = { ...state, phase: 'BOOKING', operationId: operation.id };
      await this.save(turn, state);
    }
    const meeting = await this.operations.apply(state.operationId!);
    await this.save(turn, {
      ...state,
      phase: meeting.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED',
      meetingId: meeting.id,
    });
    return this.confirmation(meeting);
  }
  private async modify(
    turn: MeetingTurn,
    meeting: Meeting,
    cancel: boolean,
  ): Promise<MeetingReply> {
    const state: MeetingState = {
      phase: cancel ? 'AWAITING_CANCEL_CONFIRMATION' : 'OFFERING',
      mode: 'RESCHEDULE',
      attemptId: randomUUID(),
      slots: [],
      selected: {
        start: meeting.startAt.toISOString(),
        end: meeting.endAt.toISOString(),
      },
      email: meeting.attendeeEmail,
      meetingId: meeting.id,
      serviceContext: meeting.serviceContext ?? undefined,
      timezone: meeting.timezone ?? this.google.config.timezone,
    };
    if (!cancel) return this.offer(turn, state);
    await this.save(turn, state);
    return {
      handled: true,
      content: `¿Confirma que desea cancelar la reunión de ${this.label(state.selected!, state.timezone)} (${state.timezone})?`,
    };
  }
  async handleTurn(turn: MeetingTurn): Promise<MeetingReply> {
    let state = readState(
      (
        await this.prisma.conversationState.findUnique({
          where: { conversationId: turn.conversationId },
        })
      )?.meetingState,
    );
    const text = normalizeMeetingText(turn.text);
    const request = isMeetingRequest(turn.text);
    const change =
      /\b(?:reprogramar|cambiar|moverla|mover|otro horario)\b/.test(text) &&
      (request || !!state?.meetingId);
    const cancel =
      /\b(?:cancelar|anular|anulemos|no puedo asistir)\b/.test(text) &&
      (request || !!state?.meetingId) &&
      !/\b(?:suscripcion|pedido|servicio|cuenta|compra)\b/.test(text);
    const pending = state && !['CONFIRMED', 'CANCELLED'].includes(state.phase);
    if (
      !request &&
      !pending &&
      !change &&
      !cancel &&
      !(
        state?.phase === 'CONFIRMED' &&
        /^(?:si|ese horario|confirmo|gracias)/.test(text)
      )
    )
      return { handled: false };
    if (!this.google.config.enabled)
      return {
        handled: true,
        errorCode: 'GOOGLE_CALENDAR_DISABLED',
        content:
          'El agendamiento por Meet no está disponible en este momento. ¿Desea que un asesor coordine la reunión?',
      };
    try {
      if (
        pending &&
        ![
          'AWAITING_CANCEL_CONFIRMATION',
          'AWAITING_RESCHEDULE_CONFIRMATION',
        ].includes(state!.phase) &&
        /\b(?:no quiero|ya no|mejor no|no gracias|ninguna|no me interesa)\b/.test(
          text,
        )
      ) {
        await this.interrupt(turn.conversationId);
        await this.save(turn, {
          ...state!,
          phase: 'CANCELLED',
          selected: undefined,
        });
        return {
          handled: true,
          content: state!.operationId
            ? 'Detuve los nuevos intentos de agendamiento. Si la solicitud ya llegó al calendario, conservaré su referencia para que un asesor verifique su estado; no puedo afirmar que esté cancelada.'
            : 'De acuerdo, dejamos el agendamiento pendiente. ¿En qué más puedo ayudarle?',
        };
      }
      if (state?.phase === 'BOOKING') return await this.book(turn, state);
      if (state?.phase === 'AWAITING_LOCATION') {
        const location = resolveMeetingLocation(turn.text);
        if (!location) return { handled: true, content: LOCATION_QUESTION };
        await this.rememberLocation(turn, location);
        state = {
          ...state,
          timezone: location.timezone,
          location,
          phase: 'AWAITING_DATE',
        };
        await this.save(turn, state);
        // Preserve relative dates from the original message even if the reply crosses midnight.
        const originalNow =
          state.requestedAt && Number.isFinite(Date.parse(state.requestedAt))
            ? new Date(state.requestedAt)
            : turn.now;
        const replyDate = parseMeetingDate(
          turn.text,
          turn.now,
          state.timezone!,
        );
        return await this.beginDate(
          turn,
          state,
          replyDate.range || replyDate.ambiguous
            ? turn.text
            : (state.requestedText ?? ''),
          replyDate.range || replyDate.ambiguous ? turn.now : originalNow,
        );
      }
      if (
        state &&
        ['OFFERING', 'AWAITING_EMAIL', 'AWAITING_DATE'].includes(state.phase) &&
        !state.timezone
      ) {
        await this.save(turn, {
          ...state,
          phase: 'AWAITING_LOCATION',
          slots: [],
          selected: undefined,
          range: undefined,
          requestedText: undefined,
        });
        return { handled: true, content: LOCATION_QUESTION };
      }
      if (
        state &&
        ['OFFERING', 'AWAITING_EMAIL', 'AWAITING_DATE'].includes(state.phase)
      ) {
        const location = resolveMeetingLocation(turn.text);
        if (location || mentionsMeetingLocation(turn.text)) {
          if (state.mode === 'RESCHEDULE')
            return {
              handled: true,
              content: `La reunión existente se reprograma en ${state.timezone}. ¿Qué día y hora le vienen bien en esa zona?`,
            };
          if (!location) {
            await this.save(turn, {
              ...state,
              phase: 'AWAITING_LOCATION',
              slots: [],
              selected: undefined,
              range: undefined,
              requestedText: turn.text,
              requestedAt: turn.now.toISOString(),
            });
            return { handled: true, content: LOCATION_QUESTION };
          }
          const oldRange = state.range;
          const day = oldRange
            ? localParts(new Date(oldRange.from), state.timezone!)
                .slice(0, 3)
                .map((n, i) => (i ? String(n).padStart(2, '0') : String(n)))
                .join('-')
            : '';
          await this.rememberLocation(turn, location);
          state = {
            ...state,
            location,
            timezone: location.timezone,
            slots: [],
            selected: undefined,
            range: undefined,
            operationId: undefined,
            attemptId: randomUUID(),
            pageOffset: 0,
          };
          await this.save(turn, state);
          const date = parseMeetingDate(turn.text, turn.now, location.timezone);
          return await this.beginDate(
            turn,
            state,
            date.range || date.ambiguous ? turn.text : day,
          );
        }
      }
      if (state?.phase === 'AWAITING_DATE')
        return await this.beginDate(turn, state, turn.text);
      if (state?.phase === 'AWAITING_MEETING_SELECTION') {
        const meetings = (await this.active(turn)).filter((m) =>
          state!.meetingChoices?.includes(m.id),
        );
        const index = text.match(/^(?:(?:la )?opcion\s*)?([1-4])[.!]?$/)?.[1];
        const matches = index
          ? meetings.filter(
              (m) => m.id === state!.meetingChoices?.[Number(index) - 1],
            )
          : meetings.filter((m) => {
              const date = parseMeetingDate(
                turn.text,
                turn.now,
                m.timezone ?? this.google.config.timezone,
              );
              return date.exact
                ? m.startAt.getTime() === Date.parse(date.exact)
                : date.range &&
                    m.startAt.getTime() >= Date.parse(date.range.from) &&
                    m.startAt.getTime() < Date.parse(date.range.to);
            });
        if (matches.length !== 1)
          return {
            handled: true,
            content:
              'Indique el número o la fecha de una única reunión de las propuestas.',
          };
        return await this.modify(turn, matches[0], !!state.cancelChoice);
      }
      if (state?.phase === 'AWAITING_RESCHEDULE_CONFIRMATION') {
        if (/^(?:si|adelante|confirmo)\b/.test(text))
          return await this.offer(turn, {
            ...state,
            mode: 'RESCHEDULE',
            attemptId: randomUUID(),
          });
        if (/^(?:no|mejor no)\b/.test(text)) {
          await this.save(turn, { ...state, phase: 'CONFIRMED' });
          return {
            handled: true,
            content: 'Su reunión se mantiene en el horario acordado.',
          };
        }
        return {
          handled: true,
          content: '¿Desea cambiar el horario de la reunión existente?',
        };
      }
      if (state?.phase === 'AWAITING_CANCEL_CONFIRMATION') {
        if (/^(?:si|confirmo|cancelala|adelante)\b/.test(text))
          return await this.book(turn, state, 'CANCEL');
        if (/^(?:no|mejor no)\b/.test(text)) {
          await this.save(turn, { ...state, phase: 'CONFIRMED' });
          return {
            handled: true,
            content: 'Su reunión se mantiene en el horario acordado.',
          };
        }
        return {
          handled: true,
          content: '¿Confirma que desea cancelar la reunión?',
        };
      }
      if (change || cancel) {
        const meetings = await this.active(turn);
        if (meetings.length > 1) {
          await this.save(turn, {
            phase: 'AWAITING_MEETING_SELECTION',
            mode: 'RESCHEDULE',
            attemptId: randomUUID(),
            slots: [],
            meetingChoices: meetings.map((m) => m.id),
            cancelChoice: cancel,
          });
          return {
            handled: true,
            content: `Hay varias reuniones activas. ¿Cuál desea modificar?\n${meetings.map((m, i) => `${i + 1}. ${this.label({ start: m.startAt.toISOString(), end: m.endAt.toISOString() }, m.timezone)} (${m.timezone})`).join('\n')}`,
          };
        }
        if (meetings.length !== 1)
          return {
            handled: true,
            content: meetings.length
              ? 'Hay varias reuniones activas. ¿Qué fecha de reunión desea modificar?'
              : 'No encontré una reunión activa para modificar. ¿Desea agendar una nueva?',
          };
        return await this.modify(turn, meetings[0], cancel);
      }
      if (state?.phase === 'CONFIRMED' && !request) {
        const meeting = state.meetingId
          ? await this.prisma.meeting.findUnique({
              where: { id: state.meetingId },
            })
          : null;
        if (meeting) return this.confirmation(meeting);
      }
      if (!state || ['CONFIRMED', 'CANCELLED'].includes(state.phase)) {
        if (state?.phase === 'CONFIRMED' && request) {
          const meetings = await this.active(turn);
          if (meetings.length === 1) {
            await this.save(turn, {
              ...state,
              phase: 'AWAITING_RESCHEDULE_CONFIRMATION',
              meetingId: meetings[0].id,
              email: meetings[0].attendeeEmail,
              timezone: meetings[0].timezone,
            });
            return {
              handled: true,
              content: `Ya tiene una reunión agendada para ${this.label({ start: meetings[0].startAt.toISOString(), end: meetings[0].endAt.toISOString() }, meetings[0].timezone)} (${meetings[0].timezone}). ¿Desea cambiar ese horario?`,
            };
          }
        }
        state = {
          phase: 'OFFERING',
          mode: 'CREATE',
          attemptId: randomUUID(),
          slots: [],
          serviceContext: turn.serviceContext,
          requestedText: turn.text,
          requestedAt: turn.now.toISOString(),
        };
        const contact = await this.prisma.contact.findUniqueOrThrow({
          where: { id: turn.contactId },
          select: { metadata: true },
        });
        const metadata =
          contact.metadata &&
          typeof contact.metadata === 'object' &&
          !Array.isArray(contact.metadata)
            ? contact.metadata
            : {};
        const explicit = resolveMeetingLocation(turn.text);
        const location =
          explicit ??
          (mentionsMeetingLocation(turn.text)
            ? undefined
            : readMeetingLocation(metadata.schedulingLocation));
        if (!location) {
          await this.save(turn, { ...state, phase: 'AWAITING_LOCATION' });
          return { handled: true, content: LOCATION_QUESTION };
        }
        if (explicit) await this.rememberLocation(turn, explicit);
        state = { ...state, timezone: location.timezone, location };
        await this.save(turn, state);
        return await this.beginDate(turn, state, turn.text);
      }
      if (
        state.phase === 'OFFERING' &&
        /\b(?:ver mas|mas horarios|siguientes|siguiente pagina|horarios anteriores|pagina anterior)\b/.test(
          text,
        )
      ) {
        const previous = /\b(?:anteriores|anterior)\b/.test(text);
        const maxOffset = Math.max(
          0,
          Math.floor((state.slots.length - 1) / PAGE_SIZE) * PAGE_SIZE,
        );
        state = {
          ...state,
          pageOffset: Math.max(
            0,
            Math.min(
              maxOffset,
              (state.pageOffset ?? 0) + (previous ? -PAGE_SIZE : PAGE_SIZE),
            ),
          ),
        };
        await this.save(turn, state);
        return this.page(state);
      }
      if (state.phase === 'AWAITING_EMAIL') {
        const email = turn.text.match(emailPattern)?.[0];
        if (!email || email.length > 254)
          return {
            handled: true,
            content:
              '¿Cuál es su correo electrónico válido para enviarle la invitación?',
          };
        await this.prisma.contact.update({
          where: { id: turn.contactId },
          data: { email },
        });
        state = { ...state, email };
        await this.save(turn, state);
        return await this.book(turn, state);
      }
      const ordinal =
        text.match(
          /^(?:(?:la )?opcion\s*)?([1-9]\d{0,3})(?:[.!]?|\s*(?:por favor|me queda bien))$/,
        )?.[1] ??
        (/^(?:si[, ]+)?(?:la |el )?(?:primera|primero)(?: opcion)?[.!]?$/.test(
          text,
        )
          ? '1'
          : /^(?:si[, ]+)?(?:la |el )?(?:segunda|segundo)(?: opcion)?[.!]?$/.test(
                text,
              )
            ? '2'
            : /^(?:si[, ]+)?(?:la |el )?(?:tercera|tercero)(?: opcion)?[.!]?$/.test(
                  text,
                )
              ? '3'
              : undefined);
      let selected = ordinal ? state.slots[Number(ordinal) - 1] : undefined;
      const explicitDate =
        /\b(?:hoy|pasado manana|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{4}-\d{2}-\d{2})\b/.test(
          text.replace(/\b(?:de|por) la manana\b/g, ''),
        );
      const proposalDates = [
        ...new Set(
          state.slots.map((s) =>
            localParts(new Date(s.start), state!.timezone!)
              .slice(0, 3)
              .map((n, i) => (i ? String(n).padStart(2, '0') : String(n)))
              .join('-'),
          ),
        ),
      ];
      if (!proposalDates.length && state.range)
        proposalDates.push(
          localParts(new Date(state.range.from), state.timezone!)
            .slice(0, 3)
            .map((n, i) => (i ? String(n).padStart(2, '0') : String(n)))
            .join('-'),
        );
      const timeOnly =
        !explicitDate &&
        /\b(?:a las?|despues de las?|desde las?|por la tarde|por la manana|\d{1,2}:\d{2})\b/.test(
          text,
        );
      if (timeOnly && proposalDates.length > 1)
        return {
          handled: true,
          content: '¿A qué fecha de las propuestas corresponde esa hora?',
        };
      const parsed = parseMeetingDate(
        timeOnly && proposalDates.length === 1
          ? `${proposalDates[0]} ${turn.text}`
          : turn.text,
        turn.now,
        state.timezone!,
      );
      if (!ordinal && parsed.ambiguous)
        return {
          handled: true,
          content:
            '¿Puede indicar la fecha y hora, aclarando si es por la mañana o por la tarde?',
        };
      if (!selected && parsed.exact)
        selected = state.slots.find(
          (s) => Date.parse(s.start) === Date.parse(parsed.exact!),
        );
      if (!selected) {
        if (parsed.range)
          return await this.offer(
            turn,
            { ...state, attemptId: randomUUID() },
            parsed.range,
          );
        return {
          handled: true,
          content:
            '¿Cuál de las opciones propuestas le queda mejor? Puede indicar el número de opción.',
        };
      }
      const contact = await this.prisma.contact.findUniqueOrThrow({
        where: { id: turn.contactId },
        select: { email: true },
      });
      const email = state.email ?? contact.email ?? undefined;
      state = {
        ...state,
        selected,
        email: email && emailPattern.test(email) ? email : undefined,
      };
      if (!state.email) {
        await this.save(turn, { ...state, phase: 'AWAITING_EMAIL' });
        return {
          handled: true,
          content:
            '¿A qué correo electrónico le envío la invitación de la reunión?',
        };
      }
      await this.save(turn, state);
      return await this.book(turn, state);
    } catch (error) {
      const code =
        error instanceof CalendarError
          ? error.code
          : 'GOOGLE_CALENDAR_EVENT_CREATE_FAILED';
      if (code === 'MEETING_SLOT_OCCUPIED' && state) {
        try {
          return await this.offer(
            turn,
            {
              ...state,
              phase: 'OFFERING',
              attemptId: randomUUID(),
              selected: undefined,
              operationId: undefined,
            },
            undefined,
            'Ese horario ya no está disponible. ',
          );
        } catch {
          /* Safe failure below. */
        }
      }
      return {
        handled: true,
        errorCode: code,
        content:
          code === 'MEETING_OPERATION_PENDING'
            ? 'Estoy verificando la reunión y su enlace de Meet. Todavía no puedo confirmar el agendamiento.'
            : 'No pude completar la gestión de la reunión en este momento. ¿Desea que un asesor le ayude a coordinarla?',
      };
    }
  }
}
