import { Controller, Get, Query } from '@nestjs/common';
import { ProductsApiService } from './products-api.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsApiService: ProductsApiService) {}

  // Exposes the same catalog lookup the AI's search_products tool uses, so
  // the moderator/admin sidebar can search real products too.
  @Get('search')
  search(@Query('q') q?: string) {
    return this.productsApiService.search(q ?? '');
  }
}
