CREATE TABLE "consumed_crm_proofs" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "consumed_crm_proofs_pkey" PRIMARY KEY ("jti")
);
CREATE INDEX "consumed_crm_proofs_expiresAt_idx" ON "consumed_crm_proofs"("expiresAt");

CREATE TABLE "mobile_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mobile_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mobile_sessions_userId_expiresAt_idx" ON "mobile_sessions"("userId", "expiresAt");
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "mobile_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
