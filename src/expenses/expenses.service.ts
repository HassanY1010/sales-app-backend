import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, businessId: string, dto: CreateExpenseDto) {
    const expense = await this.prisma.expense.create({
      data: {
        amount: dto.amount,
        description: dto.description,
        date: dto.date ? new Date(dto.date) : new Date(),
        userId,
        businessId,
      },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'CREATE',
        resource: 'EXPENSE',
        resourceId: expense.id,
        details: { amount: dto.amount, description: dto.description },
      },
    });

    return expense;
  }

  async findAll(businessId: string, pagination: PaginationDto) {
    const { page = 1, limit = 10 } = pagination;
    const where = { businessId };

    const [data, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  async findOne(businessId: string, id: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
    });

    if (!expense || expense.businessId !== businessId) {
      throw new NotFoundException('المصروف غير موجود');
    }

    return expense;
  }

  async update(businessId: string, id: string, dto: Partial<CreateExpenseDto>) {
    const expense = await this.findOne(businessId, id);

    const updated = await this.prisma.expense.update({
      where: { id },
      data: {
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.date && { date: new Date(dto.date) }),
      },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        businessId,
        action: 'UPDATE',
        resource: 'EXPENSE',
        resourceId: id,
        details: { changes: dto, previousAmount: expense.amount },
      },
    });

    return updated;
  }

  async remove(businessId: string, id: string) {
    await this.findOne(businessId, id);

    await this.prisma.expense.delete({ where: { id } });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        businessId,
        action: 'DELETE',
        resource: 'EXPENSE',
        resourceId: id,
      },
    });

    return { message: 'تم حذف المصروف بنجاح' };
  }
}
