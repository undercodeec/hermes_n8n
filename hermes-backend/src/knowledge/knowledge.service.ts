import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentType } from '@prisma/client';

@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateDocumentDto) {
    return this.prisma.knowledgeDocument.create({ data: dto });
  }

  async findAll(page = 1, limit = 20, type?: DocumentType, activeOnly = true) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (type) where.type = type;
    if (activeOnly) where.isActive = true;

    const [data, total] = await Promise.all([
      this.prisma.knowledgeDocument.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.knowledgeDocument.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const doc = await this.prisma.knowledgeDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return doc;
  }

  async update(id: string, dto: UpdateDocumentDto) {
    const doc = await this.findOne(id);
    // Incrementar versión si se actualiza contenido
    const data: any = { ...dto };
    if (dto.content && dto.content !== doc.content) {
      data.version = doc.version + 1;
    }
    return this.prisma.knowledgeDocument.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.knowledgeDocument.delete({ where: { id } });
  }

  /**
   * Búsqueda simple por contenido (para futuro reemplazo con embeddings)
   */
  async search(query: string, type?: DocumentType) {
    const where: any = {
      isActive: true,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { content: { contains: query, mode: 'insensitive' } },
      ],
    };
    if (type) where.type = type;

    return this.prisma.knowledgeDocument.findMany({
      where,
      take: 10,
      orderBy: { updatedAt: 'desc' },
    });
  }
}
