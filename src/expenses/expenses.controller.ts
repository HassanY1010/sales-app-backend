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
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('api/v1/expenses')
@UseGuards(JwtAuthGuard)
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Post()
  create(@Request() req: any, @Body() dto: CreateExpenseDto) {
    return this.expensesService.create(req.user.sub, dto);
  }

  @Get()
  findAll(@Request() req: any, @Query() pagination: PaginationDto) {
    return this.expensesService.findAll(req.user.sub, pagination);
  }

  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    return this.expensesService.findOne(req.user.sub, id);
  }

  @Put(':id')
  update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: Partial<CreateExpenseDto>,
  ) {
    return this.expensesService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  remove(@Request() req: any, @Param('id') id: string) {
    return this.expensesService.remove(req.user.sub, id);
  }
}
