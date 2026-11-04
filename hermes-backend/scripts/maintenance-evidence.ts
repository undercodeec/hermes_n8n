/** Shared, fail-closed gate for manually approved CRM maintenance. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

type Evidence = {
  operation: string;
  authorizationId: string;
  backupId: string;
  databaseId: string;
  backupPath: string;
  backupSha256: string;
  backupCreatedAt: string;
  restoreId: string;
  restoreVerifiedAt: string;
  restoreResult: 'PASS';
  commercialApprovalId?: string;
  approvedMarket?: 'EC';
  expiresAt: string;
};

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..\\`) &&
    !path.startsWith('../') &&
    !isAbsolute(path)
  );
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function verifyManualMaintenanceEvidence(input: {
  operation: string;
  authorizationId?: string;
  backupId?: string;
  evidencePath?: string;
  commercialApprovalId?: string;
  approvedMarket?: 'EC';
}): Promise<{ evidenceSha256: string; backupSha256: string }> {
  const root = process.env.HERMES_MAINTENANCE_EVIDENCE_DIR;
  const keyPath = process.env.HERMES_MAINTENANCE_TRUSTED_PUBLIC_KEY;
  const databaseId = process.env.HERMES_MAINTENANCE_DATABASE_ID;
  if (
    !root ||
    !keyPath ||
    !databaseId ||
    !input.evidencePath ||
    !input.authorizationId ||
    !input.backupId
  )
    throw new Error(
      'Protected maintenance evidence, authorization and backup are required',
    );
  const rootPath = await realpath(root);
  const filePath = await realpath(input.evidencePath);
  const trustedKeyPath = await realpath(keyPath);
  if (
    !within(rootPath, filePath) ||
    !isAbsolute(input.evidencePath) ||
    within(resolve(process.cwd()), trustedKeyPath)
  )
    throw new Error(
      'Evidence or trusted key is outside its protected location',
    );
  if (
    (await lstat(input.evidencePath)).isSymbolicLink() ||
    (await lstat(keyPath)).isSymbolicLink()
  )
    throw new Error('Symlinked maintenance evidence or key is forbidden');
  const raw = await readFile(filePath);
  const document = JSON.parse(raw.toString('utf8')) as {
    evidence?: Evidence;
    signature?: string;
  };
  const proof = document.evidence;
  if (
    !proof ||
    !document.signature ||
    !verify(
      null,
      Buffer.from(JSON.stringify(proof)),
      createPublicKey(await readFile(trustedKeyPath)),
      Buffer.from(document.signature, 'base64'),
    )
  )
    throw new Error('Maintenance evidence signature is invalid');
  const now = Date.now();
  const backupAt = Date.parse(proof.backupCreatedAt);
  const restoredAt = Date.parse(proof.restoreVerifiedAt);
  const expiresAt = Date.parse(proof.expiresAt);
  if (
    proof.operation !== input.operation ||
    proof.authorizationId !== input.authorizationId ||
    proof.backupId !== input.backupId ||
    proof.databaseId !== databaseId ||
    (input.commercialApprovalId !== undefined &&
      (proof.commercialApprovalId !== input.commercialApprovalId ||
        !/^COMM-[A-Z0-9-]{8,}$/u.test(proof.commercialApprovalId))) ||
    (input.approvedMarket !== undefined &&
      proof.approvedMarket !== input.approvedMarket) ||
    !/^AUTH-[A-Z0-9-]{8,}$/u.test(proof.authorizationId) ||
    !/^BKP-[A-Z0-9-]{8,}$/u.test(proof.backupId) ||
    !proof.restoreId ||
    proof.restoreResult !== 'PASS' ||
    !Number.isFinite(backupAt) ||
    !Number.isFinite(restoredAt) ||
    !Number.isFinite(expiresAt) ||
    backupAt > now ||
    now - backupAt > 24 * 60 * 60 * 1000 ||
    restoredAt < backupAt ||
    restoredAt > now ||
    now - restoredAt > 24 * 60 * 60 * 1000 ||
    expiresAt <= now ||
    expiresAt > now + 24 * 60 * 60 * 1000 ||
    !/^[a-f0-9]{64}$/u.test(proof.backupSha256)
  )
    throw new Error(
      'Maintenance authorization or restore evidence is stale or mismatched',
    );
  const backupPath = await realpath(proof.backupPath);
  if (
    !isAbsolute(proof.backupPath) ||
    !within(rootPath, backupPath) ||
    (await lstat(proof.backupPath)).isSymbolicLink() ||
    !(await lstat(backupPath)).isFile()
  )
    throw new Error('Protected backup file is invalid');
  if ((await sha256(backupPath)) !== proof.backupSha256)
    throw new Error('Backup SHA-256 integrity check failed');
  return {
    evidenceSha256: createHash('sha256').update(raw).digest('hex'),
    backupSha256: proof.backupSha256,
  };
}
