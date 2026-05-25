import { Controller, Get, Query, UseGuards, ForbiddenException } from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';

@Controller('businesses')
@UseGuards(JwtAuthGuard)
export class BusinessesController {
  constructor(private readonly businessesService: BusinessesService) {}

  @Get('search')
  search(@CurrentUser() user: any, @Query('query') query: string) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }

    return this.businessesService.search(user.businessId, query);
  }
}
