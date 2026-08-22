import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from '../chat/entities/customer.entity';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
  ) {}

  async updateNotes(id: string, notes: string): Promise<Customer> {
    const customer = await this.customerRepo.findOne({ where: { id } });
    if (!customer) {
      throw new NotFoundException(`Customer ${id} not found`);
    }
    // Store as undefined (-> NULL) rather than an empty string so "no note"
    // reads the same whether it was never set or was cleared.
    customer.notes = notes.trim() || undefined;
    return this.customerRepo.save(customer);
  }
}
