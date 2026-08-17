import { Module } from '@nestjs/common';
import { ProductsApiService } from './products-api.service';
import { ProductsController } from './products.controller';

@Module({
  controllers: [ProductsController],
  providers: [ProductsApiService],
  exports: [ProductsApiService],
})
export class ProductsModule {}
