import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || 'Administrador Hermes';

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL y ADMIN_PASSWORD son obligatorios');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD debe tener al menos 12 caracteres');
  }

  const prisma = new PrismaClient();
  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.upsert({
      where: { email },
      update: {
        password: hashedPassword,
        name,
        role: UserRole.ADMIN,
        isActive: true,
      },
      create: {
        email,
        password: hashedPassword,
        name,
        role: UserRole.ADMIN,
      },
      select: { id: true, email: true },
    });
    process.stdout.write(
      `Operador ADMIN preparado: ${user.email} (${user.id})\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`No se pudo crear el operador: ${message}\n`);
  process.exitCode = 1;
});
