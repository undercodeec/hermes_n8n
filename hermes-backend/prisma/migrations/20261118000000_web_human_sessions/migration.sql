CREATE TABLE "web_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "web_sessions_userId_expiresAt_idx" ON "web_sessions"("userId", "expiresAt");
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
