import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateMessageDto) {
    return this.prisma.message.create({ data: dto });
  }

  async findByConversation(conversationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const message = await this.prisma.message.findUnique({ where: { id } });
    if (!message) throw new NotFoundException('Mensaje no encontrado');
    return message;
  }
}
