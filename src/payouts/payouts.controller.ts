import { Controller, Post, Get, Body, Param, Query, UseGuards, ForbiddenException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@Controller('payouts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async createPayout(
    @Body('agentId') agentId: string,
    @Body('notes') notes?: string,
    @Body('receiptUrl') receiptUrl?: string
  ) {
    return this.payoutsService.createPayout(agentId, notes, receiptUrl);
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async findAll(@Query('agentId') agentId?: string) {
    return this.payoutsService.findAll(agentId);
  }

  @Get('agent/:agentId')
  async findByAgentId(@Param('agentId') agentId: string, @CurrentUser() user: any) {
    const isOwnerOrAdmin = await this.checkIsOwnerOrAdmin(user, agentId);
    if (!isOwnerOrAdmin) {
      throw new ForbiddenException('غير مصرح لك بعرض مدفوعات هذا المندوب.');
    }
    return this.payoutsService.findAll(agentId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    const payout = await this.payoutsService.findOne(id);
    const isOwnerOrAdmin = await this.checkIsOwnerOrAdmin(user, payout.agentId);
    if (!isOwnerOrAdmin) {
      throw new ForbiddenException('غير مصرح لك بعرض تفاصيل عملية الصرف هذه.');
    }
    return payout;
  }

  private async checkIsOwnerOrAdmin(user: any, agentId: string): Promise<boolean> {
    if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN) {
      return true;
    }
    const prisma = (this.payoutsService as any).prisma;
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    return agent && agent.userId === user.userId;
  }
}
