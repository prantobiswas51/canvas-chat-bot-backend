import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { UpdateOrderDto } from './dto/update-order.dto';

export interface CreateOrderInput {
  customerName: string;
  address: string;
  phone: string;
  productSku: string;
  quantity?: number;
  unitPrice?: number;
  notes?: string;
  createdByAi?: boolean;
  conversationId?: string;
  customerId?: string;
}

function generateInvoiceId(): string {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `INV-${datePart}-${randomPart}`;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const quantity = input.quantity && input.quantity > 0 ? Math.floor(input.quantity) : 1;
    const unitPrice = input.unitPrice;
    const totalPrice = unitPrice !== undefined ? unitPrice * quantity : undefined;

    const order = this.orderRepo.create({
      invoiceId: generateInvoiceId(),
      customerName: input.customerName,
      address: input.address,
      phone: input.phone,
      productSku: input.productSku,
      quantity,
      unitPrice: unitPrice !== undefined ? unitPrice.toFixed(2) : undefined,
      totalPrice: totalPrice !== undefined ? totalPrice.toFixed(2) : undefined,
      status: OrderStatus.PENDING,
      notes: input.notes,
      createdByAi: input.createdByAi ?? false,
      conversationId: input.conversationId,
      customerId: input.customerId,
    });

    const saved = await this.orderRepo.save(order);
    this.logger.log(`Order ${saved.invoiceId} created (SKU ${saved.productSku} × ${saved.quantity}, AI: ${saved.createdByAi})`);
    return saved;
  }

  async list(params: {
    page: number;
    limit: number;
    search?: string;
    status?: OrderStatus;
  }): Promise<{ data: Order[]; total: number; page: number; limit: number }> {
    const { page, limit, search, status } = params;
    const qb = this.orderRepo.createQueryBuilder('order').orderBy('order.createdAt', 'DESC');

    if (status) {
      qb.andWhere('order.status = :status', { status });
    }

    if (search?.trim()) {
      qb.andWhere(
        '(order.invoiceId ILIKE :search OR order.customerName ILIKE :search OR order.phone ILIKE :search ' +
          'OR order.address ILIKE :search OR order.productSku ILIKE :search)',
        { search: `%${search.trim()}%` },
      );
    }

    const [data, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async stats(): Promise<{ total: number; aiGenerated: number }> {
    const [total, aiGenerated] = await Promise.all([
      this.orderRepo.count(),
      this.orderRepo.count({ where: { createdByAi: true } }),
    ]);
    return { total, aiGenerated };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderRepo.findOne({ where: { id } });
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return order;
  }

  async update(id: string, patch: UpdateOrderDto): Promise<Order> {
    const order = await this.findOne(id);

    if (patch.customerName !== undefined) order.customerName = patch.customerName;
    if (patch.address !== undefined) order.address = patch.address;
    if (patch.phone !== undefined) order.phone = patch.phone;
    if (patch.productSku !== undefined) order.productSku = patch.productSku;
    if (patch.notes !== undefined) order.notes = patch.notes;
    if (patch.status !== undefined) order.status = patch.status;
    if (patch.quantity !== undefined) order.quantity = patch.quantity;
    if (patch.unitPrice !== undefined) order.unitPrice = patch.unitPrice.toFixed(2);

    // Re-derive totalPrice whenever either factor changed — stored
    // denormalized so the orders list/table doesn't need to compute it
    // client-side, but that means it goes stale if we don't recompute here.
    if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
      const unitPrice = order.unitPrice !== undefined ? parseFloat(order.unitPrice) : undefined;
      order.totalPrice = unitPrice !== undefined ? (unitPrice * order.quantity).toFixed(2) : order.totalPrice;
    }

    const saved = await this.orderRepo.save(order);
    this.logger.log(`Order ${saved.invoiceId} updated`);
    return saved;
  }

  async remove(id: string): Promise<void> {
    const order = await this.findOne(id);
    await this.orderRepo.remove(order);
    this.logger.log(`Order ${order.invoiceId} deleted`);
  }
}
