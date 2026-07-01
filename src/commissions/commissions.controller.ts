import {
  Controller,
  Get,
  Patch,
  Body,
  Query,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { CommissionsService } from './commissions.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { UserRole, CommissionStatus } from '@prisma/client';

@Controller('commissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CommissionsController {
  constructor(private readonly commissionsService: CommissionsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async findAll(
    @Query('agentId') agentId?: string,
    @Query('status') status?: CommissionStatus,
  ) {
    return this.commissionsService.findAll({ agentId, status });
  }

  @Get('agent/:agentId')
  async findByAgentId(
    @Param('agentId') agentId: string,
    @Query('status') status: CommissionStatus,
    @CurrentUser() user: any,
  ) {
    // Verify user owns the agent profile or is Admin
    const isOwnerOrAdmin = await this.checkIsOwnerOrAdmin(user, agentId);
    if (!isOwnerOrAdmin) {
      throw new ForbiddenException('غير مصرح لك بعرض عمولات هذا المندوب.');
    }
    return this.commissionsService.findAll({ agentId, status });
  }

  @Patch(':id/status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: CommissionStatus,
    @Body('notes') notes?: string,
  ) {
    return this.commissionsService.updateStatus(id, status, notes);
  }

  private async checkIsOwnerOrAdmin(
    user: any,
    agentId: string,
  ): Promise<boolean> {
    if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN) {
      return true;
    }
    // Fetch agent profile by userId
    const prisma = (this.commissionsService as any).prisma;
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    return agent && agent.userId === user.userId;
  }
}
