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
import { CreateConnectionDto } from './dto/create-connection.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('api/v1/connections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business') // Only businesses can manage connections
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
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.acceptConnection(user.businessId, connectionId);
  }

  @Patch(':id/reject')
  async rejectConnection(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.rejectConnection(user.businessId, connectionId);
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
    return this.connectionsService.getConnections(user.businessId, pagination, search);
  }

  @Patch(':id/block')
  async blockConnection(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.blockConnection(user.businessId, connectionId);
  }

  @Patch(':id/unblock')
  async unblockConnection(
    @CurrentUser() user: any,
    @Param('id') connectionId: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.connectionsService.unblockConnection(user.businessId, connectionId);
  }
}
