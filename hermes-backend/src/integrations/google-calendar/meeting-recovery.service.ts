import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MeetingOperationsService } from './meeting-operations.service';

@Injectable()
export class MeetingRecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly operations: MeetingOperationsService) {}
  onModuleInit(): void {
    this.timer = setInterval(() => void this.scan(), 60000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
  private async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.operations.recover();
    } catch {
      /* No raw infrastructure exceptions in logs. */
    } finally {
      this.running = false;
    }
  }
}
