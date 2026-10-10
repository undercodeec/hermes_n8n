import {
  closeSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { EvaluationResult } from './phase0-evaluation-harness';

/** Writes one result at a time and publishes a complete JSON report atomically. */
export class Phase0ReportWriter {
  private readonly outputPath?: string;
  private readonly partialPath?: string;
  private descriptor?: number;
  private count = 0;

  constructor(
    mode: 'offline' | 'provider',
    fixtureCount: number,
    output?: string,
  ) {
    if (output) {
      this.outputPath = resolve(output);
      this.partialPath = `${this.outputPath}.partial-${randomUUID()}`;
      this.descriptor = openSync(this.partialPath, 'wx', 0o600);
    }
    this.write(
      `{"mode":${JSON.stringify(mode)},"fixtureCount":${fixtureCount},"results":[\n`,
    );
  }

  append(result: EvaluationResult): void {
    this.write(`${this.count ? ',\n' : ''}${JSON.stringify(result, null, 2)}`);
    this.count++;
  }

  finish(): number {
    this.write(`\n],"evaluated":${this.count}}\n`);
    if (this.descriptor !== undefined) {
      closeSync(this.descriptor);
      this.descriptor = undefined;
      renameSync(this.partialPath!, this.outputPath!);
    }
    return this.count;
  }

  abort(): void {
    if (this.descriptor !== undefined) {
      closeSync(this.descriptor);
      this.descriptor = undefined;
    }
    if (this.partialPath) unlinkSync(this.partialPath);
  }

  private write(value: string): void {
    if (this.descriptor === undefined) {
      process.stdout.write(value);
      return;
    }
    const bytes = Buffer.from(value);
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(
        this.descriptor,
        bytes,
        offset,
        bytes.length - offset,
      );
  }
}
