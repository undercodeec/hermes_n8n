import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const candidates = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: repositoryRoot, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const textExtensions = new Set([
  '',
  '.env',
  '.json',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
  '.md',
  '.sh',
  '.ps1',
  '.sql',
  '.toml',
]);
const placeholder =
  /^(?:|<.*>|\$\{.*\}|(?:generate|replace|change-me|example|dummy|fake|mock|test|fixture)[-_\s].*)$/i;
const assignment =
  /^\s*(?:-\s*)?["']?([a-z_][a-z0-9_.-]*)["']?\s*[:=]\s*(.*?)\s*[,;]?\s*$/i;
const findings = [];

function isSecretName(name) {
  return (
    /(?:^|[_.-])(?:password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|encryption[_-]?key)(?:$|[_.-])/i.test(
      name,
    ) ||
    /(?:Password|Secret|AccessToken|RefreshToken|ApiKey|EncryptionKey)$/.test(
      name,
    )
  );
}

function report(file, line, name, reason) {
  findings.push({ file, line, name, reason });
}

for (const relativePath of candidates) {
  const absolutePath = resolve(repositoryRoot, relativePath);
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  if (!textExtensions.has(extname(relativePath).toLowerCase())) continue;

  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) continue;
  const lines = buffer.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || /^(?:#|\/\/|\*)/.test(trimmed)) return;

    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
      report(relativePath, index + 1, 'PRIVATE_KEY', 'private key delimiter');
    }
    if (/\bBearer\s+[A-Za-z0-9._-]{20,}\b/.test(line)) {
      report(relativePath, index + 1, 'BEARER', 'literal bearer token');
    }
    if (/\bAIza[0-9A-Za-z_-]{30,}\b/.test(line)) {
      report(relativePath, index + 1, 'GOOGLE_API_KEY', 'Google API key shape');
    }
    if (/\bEA[A-Za-z0-9]{50,}\b/.test(line)) {
      report(relativePath, index + 1, 'META_ACCESS_TOKEN', 'Meta token shape');
    }

    const url = line.match(/[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:([^\s/@]+)@/i);
    if (url && !placeholder.test(url[1])) {
      report(
        relativePath,
        index + 1,
        'CREDENTIAL_URL',
        'embedded URL credential',
      );
    }

    const match = line.match(assignment);
    if (!match) return;
    const name = match[1];
    if (!isSecretName(name)) return;
    if (/\.spec\.[cm]?[jt]sx?$|(?:^|\/)test\//i.test(relativePath)) return;
    const value = match[2].replace(/^['"]|['"]$/g, '').trim();
    if (/_FILE$/i.test(name) || placeholder.test(value)) return;
    const envStyle = name === name.toUpperCase();
    const quotedLiteral = /^\s*['"`]/.test(match[2]);
    if (!envStyle && !quotedLiteral) return;
    report(relativePath, index + 1, name, 'literal secret assignment');
  });
}

if (findings.length) {
  console.error(`Secret scan failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(
      `${finding.file}:${finding.line} ${finding.name} (${finding.reason})`,
    );
  }
  process.exit(1);
}

console.log(
  `Secret scan passed: ${candidates.length} repository file(s) checked.`,
);
