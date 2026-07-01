import {
  Controller,
  Post,
  Param,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FinanceService } from './finance.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';

@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FinanceController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Rebuild balance for an account.
   * Access is restricted to:
   *   - Super admins / Admins
   *   - The business owner whose account is being rebuilt
   * (Blocker-03)
   */
  @Post('rebuild-balance/:accountId')
  @Roles('business', 'SUPER_ADMIN', 'ADMIN')
  async rebuildBalance(
    @Param('accountId') accountId: string,
    @CurrentUser() user: any,
  ) {
    // Admins can rebuild any account
    const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
    if (!isAdmin) {
      // Non-admins must own a business that is part of the connection
      if (!user.businessId) {
        throw new ForbiddenException('Access denied');
      }

      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
        include: { connection: true },
      });

      if (!account) throw new NotFoundException('Account not found');

      const { requesterId, receiverId } = account.connection;
      const ownsAccount =
        requesterId === user.businessId || receiverId === user.businessId;

      if (!ownsAccount) {
        throw new ForbiddenException(
          'You do not have permission to rebuild this account balance',
        );
      }
    }

    return this.financeService.rebuildAccountBalance(accountId);
  }
}
