import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import {
  AdminUsersQueryDto,
  ChangeUserRoleDto,
  ToggleUserStatusDto,
} from './dto/admin-user.dto';
import {
  AdminBusinessesQueryDto,
  ToggleBusinessStatusDto,
  BusinessStatsDto,
} from './dto/admin-business.dto';
import {
  AdminOrdersQueryDto,
  UpdateOrderStatusDto,
} from './dto/admin-order.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transaction.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { AdjustmentRequestsService } from '../adjustment-requests/adjustment-requests.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly adjustmentRequestsService: AdjustmentRequestsService,
  ) {}

  // ==================== Dashboard ====================
  @Get('dashboard/stats')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  @Get('operations/summary')
  @Roles('SUPER_ADMIN', 'ADMIN')
  getOperationsSummary() {
    return this.adminService.getOperationsSummary();
  }

  // ==================== Users ====================
  @Get('users')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getUsers(@Query() query: AdminUsersQueryDto, @Request() req: any) {
    return this.adminService.getUsers(query, req.user.userId);
  }

  @Get('users/:id')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getUserById(@Param('id') id: string) {
    return this.adminService.getUserById(id);
  }

  @Put('users/change-role')
  @Roles('SUPER_ADMIN')
  changeUserRole(@Body() dto: ChangeUserRoleDto, @Request() req: any) {
    return this.adminService.changeUserRole(dto, req.user.userId);
  }

  @Put('users/toggle-status')
  @Roles('SUPER_ADMIN', 'ADMIN')
  toggleUserStatus(@Body() dto: ToggleUserStatusDto, @Request() req: any) {
    return this.adminService.toggleUserStatus(dto, req.user.userId);
  }

  @Put('users/:id/reset-password')
  @Roles('SUPER_ADMIN', 'ADMIN')
  resetUserPassword(
    @Param('id') id: string,
    @Body() dto: any,
    @Request() req: any,
  ) {
    return this.adminService.resetUserPassword(id, req.user.userId, dto);
  }

  @Delete('users/:id')
  @Roles('SUPER_ADMIN')
  deleteUser(@Param('id') id: string, @Request() req: any) {
    return this.adminService.deleteUser(id, req.user.userId);
  }

  // ==================== Businesses ====================
  @Get('businesses')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getBusinesses(@Query() query: AdminBusinessesQueryDto) {
    return this.adminService.getBusinesses(query);
  }

  @Get('businesses/:id')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getBusinessById(@Param('id') id: string) {
    return this.adminService.getBusinessById(id);
  }

  @Put('businesses/toggle-status')
  @Roles('SUPER_ADMIN', 'ADMIN')
  toggleBusinessStatus(
    @Body() dto: ToggleBusinessStatusDto,
    @Request() req: any,
  ) {
    return this.adminService.toggleBusinessStatus(dto, req.user.userId);
  }

  @Get('businesses/:id/stats')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getBusinessStats(@Param('id') id: string, @Query() query: any) {
    return this.adminService.getBusinessStats({ businessId: id, ...query });
  }

  // ==================== Orders ====================
  @Get('orders')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getOrders(@Query() query: AdminOrdersQueryDto) {
    return this.adminService.getOrders(query);
  }

  @Get('orders/:id')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getOrderById(@Param('id') id: string) {
    return this.adminService.getOrderById(id);
  }

  // ==================== Transactions ====================
  @Get('transactions')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getTransactions(@Query() query: AdminTransactionsQueryDto) {
    return this.adminService.getTransactions(query);
  }

  // ==================== Connections ====================
  @Get('connections')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getConnections(
    @Query()
    query: PaginationDto & { status?: string; connectionType?: string },
  ) {
    return this.adminService.getConnections(query);
  }

  // ==================== Accounts (Ledger) ====================
  @Get('accounts')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getAccounts(@Query() query: PaginationDto & { search?: string }) {
    return this.adminService.getAccounts(query);
  }

  @Get('accounts/:id')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getAccountById(@Param('id') id: string) {
    return this.adminService.getAccountById(id);
  }

  @Get('due-accounts')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getDueAccounts(@Query() query: PaginationDto & { includeFuture?: string }) {
    return this.adminService.getDueAccounts(query);
  }

  // ==================== Adjustment Requests ====================
  @Get('adjustment-requests')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getAdjustmentRequests(
    @Query() query: PaginationDto & { status?: string; targetType?: string },
  ) {
    return this.adminService.getAdjustmentRequests(query);
  }

  @Put('adjustment-requests/:id/reject')
  @Roles('SUPER_ADMIN', 'ADMIN')
  rejectAdjustmentRequest(
    @Param('id') id: string,
    @Body('rejectionReason') rejectionReason: string,
    @Request() req: any,
  ) {
    return this.adminService.rejectAdjustmentRequest(
      id,
      rejectionReason,
      req.user.userId,
    );
  }

  /** Admin force-approve an adjustment request (Blocker-02) */
  @Put('adjustment-requests/:id/approve')
  @Roles('SUPER_ADMIN', 'ADMIN')
  approveAdjustmentRequest(@Param('id') id: string, @Request() req: any) {
    // Admin acts as the receiverBusinessId party — delegate to the business-level service
    // but bypass the receiverBusinessId ownership check by using a special admin override.
    return this.adminService.adminApproveAdjustmentRequest(id, req.user.userId);
  }

  // ==================== Expenses ====================
  @Get('expenses')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getExpenses(
    @Query()
    query: PaginationDto & {
      userId?: string;
      startDate?: string;
      endDate?: string;
    },
  ) {
    return this.adminService.getExpenses(query);
  }

  // ==================== Notifications ====================
  @Get('notifications')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getNotifications(
    @Query() query: PaginationDto & { userId?: string; isRead?: boolean },
  ) {
    return this.adminService.getNotifications(query);
  }

  @Get('notifications/count')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getNotificationsCount(@Query('isRead') isRead?: string) {
    return this.adminService.getNotificationsCount(
      isRead === 'true' ? true : isRead === 'false' ? false : undefined,
    );
  }

  @Post('notifications/send')
  @Roles('SUPER_ADMIN', 'ADMIN')
  sendNotification(
    @Body() dto: { userId: string; title: string; body: string; type?: string },
    @Request() req: any,
  ) {
    return this.adminService.sendNotification(
      req.user.userId,
      dto.userId,
      dto.title,
      dto.body,
      dto.type,
    );
  }

  @Post('notifications/send-bulk')
  @Roles('SUPER_ADMIN', 'ADMIN')
  sendBulkNotification(
    @Body()
    dto: { userIds: string[]; title: string; body: string; type?: string },
    @Request() req: any,
  ) {
    return this.adminService.sendBulkNotification(
      req.user.userId,
      dto.userIds,
      dto.title,
      dto.body,
      dto.type,
    );
  }

  @Put('notifications/:id/read')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  markNotificationAsRead(@Param('id') id: string) {
    return this.adminService.markNotificationAsRead(id);
  }

  // ==================== Audit Logs ====================
  @Get('audit-logs')
  @Roles('SUPER_ADMIN', 'ADMIN')
  getAuditLogs(
    @Query()
    query: PaginationDto & {
      userId?: string;
      action?: string;
      resource?: string;
    },
  ) {
    return this.adminService.getAuditLogs(query);
  }

  // ==================== Suggestions ====================
  @Get('suggestions')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getSuggestions(@Query() query: PaginationDto & { status?: string }) {
    return this.adminService.getSuggestions(query);
  }

  @Put('suggestions/:id/status')
  @Roles('SUPER_ADMIN', 'ADMIN')
  updateSuggestionStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.adminService.updateSuggestionStatus(id, status);
  }

  // ==================== Reports ====================
  @Get('reports/financial')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  getFinancialReport(@Query() query: { startDate?: string; endDate?: string }) {
    return this.adminService.getFinancialReport(query.startDate, query.endDate);
  }

  // ==================== System Settings ====================
  @Get('settings')
  @Roles('SUPER_ADMIN')
  getSystemSettings() {
    return this.adminService.getSystemSettings();
  }

  @Put('settings')
  @Roles('SUPER_ADMIN')
  updateSystemSetting(
    @Body() dto: { key: string; value: any; isPublic?: boolean },
  ) {
    return this.adminService.updateSystemSetting(
      dto.key,
      dto.value,
      dto.isPublic,
    );
  }
}
