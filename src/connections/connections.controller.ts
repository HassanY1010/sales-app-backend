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
import { LinkConnectionsDto } from './dto/link-connections.dto';
import { SendRelationshipRequestDto } from './dto/send-relationship-request.dto';
import { GetConnectionsDto } from './dto/get-connections.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('connections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business', 'individual', 'consumer') // Merchants and Consumers can both manage connections
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Get('requests/stats')
  async getConnectionRequestsStats(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.getConnectionRequestsStats(user.businessId);
  }

  @Patch('requests/mark-read')
  async markConnectionRequestsAsRead(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.markConnectionRequestsAsRead(user.businessId);
  }

  @Get('requests')
  async getConnectionRequests(
    @CurrentUser() user: any,
    @Query() query: {
      status?: string;
      search?: string;
      startDate?: string;
      endDate?: string;
      page?: number;
      limit?: number;
    },
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.getConnectionRequests(user.businessId, query);
  }

  @Get('requests/:id')
  async getConnectionRequestDetails(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.getConnectionRequestDetails(
      user.businessId,
      user.id,
      id,
    );
  }

  @Get('requests/:id/audit')
  async getConnectionRequestAudit(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.getConnectionRequestAudit(user.businessId, id);
  }

  @Patch('requests/:id/accept')
  async acceptConnectionRequest(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
    @Body() body: AcceptConnectionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.acceptConnection(
      user.businessId,
      user.id,
      connectionId,
      body,
    );
  }

  @Patch('requests/:id/reject')
  async rejectConnectionRequest(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.rejectConnection(
      user.businessId,
      user.id,
      connectionId,
    );
  }

  @Patch('requests/:id/cancel')
  async cancelConnectionRequest(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.cancelConnection(
      user.businessId,
      user.id,
      connectionId,
    );
  }

  @Post()
  async createConnection(
    @CurrentUser() user: any,
    @Body() dto: CreateConnectionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.createConnection(user.businessId, user.id, dto);
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
      user.id,
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
      user.id,
      connectionId,
    );
  }

  @Get()
  async getConnections(
    @CurrentUser() user: any,
    @Query() query: GetConnectionsDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.getConnections(
      user.businessId,
      query,
      query.search,
      query.type,
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

  /**
   * New unified endpoint: send a relationship request by phone number.
   * Handles both registered and unregistered receivers.
   * POST /connections/request-by-phone
   */
  @Post('request-by-phone')
  @Roles('business', 'individual', 'consumer')
  async sendRelationshipRequestByPhone(
    @CurrentUser() user: any,
    @Body() dto: SendRelationshipRequestDto,
  ) {
    const callerId = user.businessId || user.id;
    return this.connectionsService.sendRelationshipRequestByPhone(
      callerId,
      user.id,
      dto,
    );
  }

  @Post('manual-add')
  @Roles('business', 'individual', 'consumer')
  async manualAdd(
    @CurrentUser() user: any,
    @Body() body: ManualAddConnectionDto,
  ) {
    const callerId = user.businessId || user.id;
    return this.connectionsService.manualAddConnection(callerId, body);
  }

  @Patch(':id/toggle-show-prices')
  @Roles('business', 'individual', 'consumer')
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
      openingBalance?: number;
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

  @Post('link')
  async linkConnections(
    @CurrentUser() user: any,
    @Body() dto: LinkConnectionsDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.linkConnections(user.businessId, user.id, dto);
  }

  @Post('unlink')
  async unlinkConnections(
    @CurrentUser() user: any,
    @Body('linkId') linkId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.unlinkConnections(user.businessId, user.id, linkId);
  }

  @Get(':id/linkable')
  async getLinkableConnections(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.getLinkableConnections(user.businessId, connectionId);
  }
}
