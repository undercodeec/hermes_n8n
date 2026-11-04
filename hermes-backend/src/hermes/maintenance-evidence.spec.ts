import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyManualMaintenanceEvidence } from '../../scripts/maintenance-evidence';

describe('signed manual maintenance gate', () => {
  const old = {
    directory: process.env.HERMES_MAINTENANCE_EVIDENCE_DIR,
    key: process.env.HERMES_MAINTENANCE_TRUSTED_PUBLIC_KEY,
    database: process.env.HERMES_MAINTENANCE_DATABASE_ID,
  };
  const dirs: string[] = [];
  afterAll(async () => {
    for (const path of dirs) await rm(path, { recursive: true, force: true });
    if (old.directory === undefined)
      delete process.env.HERMES_MAINTENANCE_EVIDENCE_DIR;
    else process.env.HERMES_MAINTENANCE_EVIDENCE_DIR = old.directory;
    if (old.key === undefined)
      delete process.env.HERMES_MAINTENANCE_TRUSTED_PUBLIC_KEY;
    else process.env.HERMES_MAINTENANCE_TRUSTED_PUBLIC_KEY = old.key;
    if (old.database === undefined)
      delete process.env.HERMES_MAINTENANCE_DATABASE_ID;
    else process.env.HERMES_MAINTENANCE_DATABASE_ID = old.database;
  });

  it('verifies signature, backup hash, restore and bound authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-maintenance-'));
    dirs.push(root);
    const evidenceDir = join(root, 'evidence');
    await mkdir(evidenceDir);
    const backupPath = join(evidenceDir, 'backup.dump');
    await writeFile(backupPath, 'synthetic disposable backup');
    const backupSha256 = createHash('sha256')
      .update(await readFile(backupPath))
      .digest('hex');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(root, 'trusted.pub');
    await writeFile(keyPath, publicKey.export({ type: 'spki', format: 'pem' }));
    process.env.HERMES_MAINTENANCE_EVIDENCE_DIR = evidenceDir;
    process.env.HERMES_MAINTENANCE_TRUSTED_PUBLIC_KEY = keyPath;
    process.env.HERMES_MAINTENANCE_DATABASE_ID = 'synthetic-test-db';
    const proof = {
      operation: 'COMMERCIAL_SUPPORT_12M',
      authorizationId: 'AUTH-12345678',
      backupId: 'BKP-12345678',
      databaseId: 'synthetic-test-db',
      backupPath,
      backupSha256,
      backupCreatedAt: new Date(Date.now() - 60_000).toISOString(),
      restoreId: 'restore-disposable-1',
      restoreVerifiedAt: new Date().toISOString(),
      restoreResult: 'PASS',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const document = (evidence: typeof proof) =>
      JSON.stringify({
        evidence,
        signature: sign(
          null,
          Buffer.from(JSON.stringify(evidence)),
          privateKey,
        ).toString('base64'),
      });
    const evidencePath = join(evidenceDir, 'approval.json');
    await writeFile(evidencePath, document(proof));
    const input = {
      operation: 'COMMERCIAL_SUPPORT_12M',
      authorizationId: proof.authorizationId,
      backupId: proof.backupId,
      evidencePath,
    };
    await expect(verifyManualMaintenanceEvidence(input)).resolves.toEqual(
      expect.objectContaining({ backupSha256 }),
    );
    await expect(
      verifyManualMaintenanceEvidence({
        ...input,
        authorizationId: 'AUTH-OTHER123',
      }),
    ).rejects.toThrow();
    await writeFile(backupPath, 'tampered backup');
    await expect(verifyManualMaintenanceEvidence(input)).rejects.toThrow(
      'SHA-256',
    );
    await writeFile(backupPath, 'synthetic disposable backup');
    await writeFile(
      evidencePath,
      document({
        ...proof,
        backupCreatedAt: new Date(
          Date.now() - 48 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    );
    await expect(verifyManualMaintenanceEvidence(input)).rejects.toThrow(
      'stale',
    );
  });
});
