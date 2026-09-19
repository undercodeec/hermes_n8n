import { Injectable, MessageEvent } from '@nestjs/common';
import { interval, map, merge, Observable, of, Subject } from 'rxjs';

export type CustomerMessageEvent = {
  messageId: string;
  conversationId: string;
  contactId: string;
  contactName: string;
  content: string;
  messageType: string;
  createdAt: string;
};

@Injectable()
export class ConversationEventsService {
  private readonly customerMessages = new Subject<MessageEvent>();

  publishCustomerMessage(event: CustomerMessageEvent): void {
    this.customerMessages.next({ type: 'customer_message', data: event });
  }

  stream(): Observable<MessageEvent> {
    return merge(
      of({
        type: 'connected',
        data: { connectedAt: new Date().toISOString() },
        retry: 3000,
      }),
      this.customerMessages.asObservable(),
      interval(25000).pipe(
        map(() => ({
          type: 'heartbeat',
          data: { at: new Date().toISOString() },
        })),
      ),
    );
  }
}
