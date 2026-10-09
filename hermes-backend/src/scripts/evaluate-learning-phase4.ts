import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluatePhase4,
  Phase4Fixture,
  Phase4RecordedOutput,
} from '../learning/phase4-evaluation';

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error(
    'Uso: npm run evaluate:learning-phase4 -- <ruta-resultados-json>',
  );
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'test/fixtures/conversation-memory.phase4.json'),
    'utf8',
  ),
) as Phase4Fixture;
const outputs = JSON.parse(
  readFileSync(resolve(inputPath), 'utf8'),
) as Phase4RecordedOutput[];
const report = evaluatePhase4(fixture, outputs);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.gate !== 'CANDIDATE_FOR_HUMAN_REVIEW') process.exitCode = 1;
