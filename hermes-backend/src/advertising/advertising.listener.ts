import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LeadQualifiedEvent } from '../common/events/lead.events';
import { AdvertisingService } from './advertising.service';

@Injectable()
export class AdvertisingListener {
  private readonly logger = new Logger(AdvertisingListener.name);

  constructor(private readonly advertising: AdvertisingService) {}

  @OnEvent('lead.qualified', { async: true })
  async onLeadQualified(event: LeadQualifiedEvent): Promise<void> {
    try {
      await this.advertising.recordQualifiedLead(
        event.leadId,
        new Date(event.occurredAt),
      );
    } catch (error) {
      this.logger.error(
        `Could not persist LEAD_QUALIFIED for lead ${event.leadId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
