import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrderStatus } from './entities/order.entity';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // Declared before ':id' so "/orders/stats" doesn't get swallowed by the
  // UUID param route below.
  @Get('stats')
  stats() {
    return this.ordersService.stats();
  }

  @Get()
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? '10', 10) || 10));
    const validStatus = status && Object.values(OrderStatus).includes(status as OrderStatus) ? (status as OrderStatus) : undefined;

    return this.ordersService.list({ page: pageNum, limit: limitNum, search, status: validStatus });
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.findOne(id);
  }
}
