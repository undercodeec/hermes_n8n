import { createServer, Server } from 'node:http';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ReviewProviderResponse =
  | Record<string, unknown>
  | string
  | ((request: Record<string, unknown>) => Record<string, unknown> | string);

export class LearningReviewProviderFixture {
  private server?: Server;
  private response: ReviewProviderResponse = {
    issueCode: 'TEST',
    summary: 'Resultado sintético',
    counterexample: null,
    confidence: 0.5,
    candidate: null,
  };
  readonly requests: Record<string, unknown>[] = [];
  private port?: number;

  get baseUrl(): string {
    if (!this.port) throw new Error('Learning provider fixture is not running');
    return `http://127.0.0.1:${this.port}/v1`;
  }

  setResponse(response: ReviewProviderResponse): void {
    this.response = response;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          response.writeHead(400).end('invalid request');
          return;
        }
        if (!isRecord(body)) {
          response.writeHead(400).end('invalid request');
          return;
        }
        this.requests.push(body);
        const selected =
          typeof this.response === 'function'
            ? this.response(body)
            : this.response;
        const content =
          typeof selected === 'string' ? selected : JSON.stringify(selected);
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Learning provider fixture has no TCP address'));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.server = undefined;
    this.port = undefined;
  }
}
