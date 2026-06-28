import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateContactDto) {
    return this.prisma.contact.create({ data: dto });
  }

  async findAll(page = 1, limit = 20, search?: string) {
    const skip = (page - 1) * limit;
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { waId: { contains: search } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { company: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [data, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { leads: true, conversations: true } } },
      }),
      this.prisma.contact.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { id },
      include: {
        leads: { orderBy: { createdAt: 'desc' } },
        conversations: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });

    if (!contact) throw new NotFoundException('Contacto no encontrado');
    return contact;
  }

  async findByWaId(waId: string) {
    return this.prisma.contact.findUnique({ where: { waId } });
  }

  async update(id: string, dto: UpdateContactDto) {
    await this.findOne(id);
    return this.prisma.contact.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.contact.delete({ where: { id } });
  }
}
