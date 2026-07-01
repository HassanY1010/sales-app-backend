import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class RegionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(name: string) {
    if (!name || name.trim() === '') {
      throw new ConflictException('اسم المنطقة مطلوب.');
    }
    const existing = await this.prisma.region.findUnique({
      where: { name: name.trim() },
    });
    if (existing) throw new ConflictException('المنطقة موجودة بالفعل.');
    return this.prisma.region.create({ data: { name: name.trim() } });
  }

  async findAll() {
    return this.prisma.region.findMany({
      include: {
        _count: {
          select: { agents: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }
}
