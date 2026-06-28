import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskStatus } from '@prisma/client';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTaskDto) {
    return this.prisma.task.create({
      data: {
        ...dto,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
      },
      include: { lead: true, conversation: true, assignedUser: true },
    });
  }

  async findAll(page = 1, limit = 20, status?: TaskStatus, assignedUserId?: string) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    if (assignedUserId) where.assignedUserId = assignedUserId;

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
        include: { lead: true, assignedUser: true },
      }),
      this.prisma.task.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { lead: { include: { contact: true } }, conversation: true, assignedUser: true },
    });
    if (!task) throw new NotFoundException('Tarea no encontrada');
    return task;
  }

  async update(id: string, dto: UpdateTaskDto) {
    await this.findOne(id);
    const data: any = { ...dto };
    if (dto.dueAt) data.dueAt = new Date(dto.dueAt);
    if (dto.status === TaskStatus.COMPLETED) data.completedAt = new Date();

    return this.prisma.task.update({
      where: { id },
      data,
      include: { lead: true, assignedUser: true },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.task.delete({ where: { id } });
  }
}
