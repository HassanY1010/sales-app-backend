import {
  Controller,
  Post,
  Patch,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ConnectionsService } from './connections.service';
import {
  AcceptConnectionDto,
  CreateConnectionDto,
} from './dto/create-connection.dto';
import { ManualAddConnectionDto } from './dto/manual-add-connection.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('connections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business', 'individual') // Merchants and Consumers can both manage connections
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Post()
  async createConnection(
    @CurrentUser() user: any,
    @Body() dto: CreateConnectionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.createConnection(user.businessId, dto);
  }

  @Patch(':id/accept')
  async acceptConnection(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
    @Body() body: AcceptConnectionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.acceptConnection(
      user.businessId,
      connectionId,
      body,
    );
  }

  @Patch(':id/reject')
  async rejectConnection(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.rejectConnection(
      user.businessId,
      connectionId,
    );
  }

  @Get()
  async getConnections(
    @CurrentUser() user: any,
    @Query() pagination: PaginationDto,
    @Query('search') search?: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.getConnections(
      user.businessId,
      pagination,
      search,
    );
  }

  @Patch(':id/block')
  async blockConnection(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.blockConnection(
      user.businessId,
      connectionId,
    );
  }

  @Patch(':id/unblock')
  async unblockConnection(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.unblockConnection(
      user.businessId,
      connectionId,
    );
  }

  @Post('manual-add')
  @Roles('business')
  async manualAdd(
    @CurrentUser() user: any,
    @Body() body: ManualAddConnectionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.manualAddConnection(user.businessId, body);
  }

  @Patch(':id/toggle-show-prices')
  @Roles('business')
  async toggleShowPrices(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
    @Body('show') show: boolean,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.toggleShowPrices(
      user.businessId,
      connectionId,
      show,
    );
  }

  @Patch(':id/account-terms')
  async updateAccountTerms(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
    @Body()
    body: {
      creditLimit?: number;
      billingCycle?: string;
      dueDate?: string | null;
    },
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.updateAccountTerms(
      user.businessId,
      connectionId,
      body,
    );
  }

  @Patch(':id')
  async updateContactInfo(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
    @Body()
    body: {
      phoneNumber?: string;
      ownerName?: string;
      notes?: string;
    },
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.updateContactInfo(
      user.businessId,
      connectionId,
      body,
    );
  }
}
