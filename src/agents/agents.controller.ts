import { Controller, Post, Get, Patch, Body, Param, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { UserRole, AgentStatus, CommissionType } from '@prisma/client';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  // Public endpoint used during registration to check referrers
  @Get('validate/:code')
  async validateCode(@Param('code') code: string) {
    const agent = await this.prismaValidateCode(code);
    return {
      valid: true,
      referralCode: agent.referralCode,
      agentId: agent.id,
      fullName: agent.userId, // We can return basic details if needed
    };
  }

  private async prismaValidateCode(code: string) {
    return this.agentsService.validateCode(code);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async create(
    @Body('userId') userId: string,
    @Body('referralCode') referralCode?: string,
    @Body('regionId') regionId?: string,
    @Body('commissionType') commissionType?: CommissionType,
    @Body('commissionValue') commissionValue?: number,
  ) {
    return this.agentsService.create(userId, regionId, commissionType, commissionValue, referralCode);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async findAll() {
    return this.agentsService.findAll();
  }

  // ── Agent self-service endpoints (for Flutter mobile) ──

  /** GET /agents/me — returns agent profile for the logged-in user */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMyProfile(@CurrentUser() user: any) {
    return this.agentsService.findByUserId(user.userId);
  }

  /** GET /agents/me/dashboard — returns stats for the logged-in agent */
  @Get('me/dashboard')
  @UseGuards(JwtAuthGuard)
  async getMyDashboard(@CurrentUser() user: any) {
    const agentProfile = await this.agentsService.findByUserId(user.userId);
    if (agentProfile.status !== AgentStatus.ACTIVE) {
      throw new ForbiddenException('حساب المندوب الخاص بك غير نشط حالياً.');
    }
    return this.agentsService.getDashboardMetrics(agentProfile.id);
  }

  /** GET /agents/me/commissions — returns commission records for the logged-in agent */
  @Get('me/commissions')
  @UseGuards(JwtAuthGuard)
  async getMyCommissions(@CurrentUser() user: any) {
    return this.agentsService.getCommissionsForUser(user.userId);
  }

  /** GET /agents/me/referrals — returns referred customers for the logged-in agent */
  @Get('me/referrals')
  @UseGuards(JwtAuthGuard)
  async getMyReferrals(@CurrentUser() user: any) {
    return this.agentsService.getReferralsForUser(user.userId);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    const agent = await this.agentsService.findOne(id);
    // Allow Admins, or the Agent themselves
    if (user.role !== UserRole.SUPER_ADMIN && user.role !== UserRole.ADMIN && user.userId !== agent.userId) {
      throw new ForbiddenException('غير مصرح لك بعرض بيانات هذا المندوب.');
    }
    return agent;
  }

  @Get(':id/dashboard')
  @UseGuards(JwtAuthGuard)
  async getDashboard(@Param('id') id: string, @CurrentUser() user: any) {
    const agent = await this.agentsService.findOne(id);
    // Allow Admins, or the Agent themselves
    if (user.role !== UserRole.SUPER_ADMIN && user.role !== UserRole.ADMIN && user.userId !== agent.userId) {
      throw new ForbiddenException('غير مصرح لك بعرض بيانات هذا المندوب.');
    }
    return this.agentsService.getDashboardMetrics(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async update(
    @Param('id') id: string,
    @Body() body: { regionId?: string; commissionType?: CommissionType; commissionValue?: number; status?: AgentStatus }
  ) {
    return this.agentsService.update(id, body);
  }

  @Patch(':id/commission')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async updateCommission(
    @Param('id') id: string,
    @Body() body: { commissionType: CommissionType; commissionValue: number }
  ) {
    return this.agentsService.update(id, body);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async setStatus(
    @Param('id') id: string,
    @Body() body: { status: AgentStatus }
  ) {
    return this.agentsService.update(id, body);
  }
}
