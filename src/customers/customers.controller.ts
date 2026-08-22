import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { UpdateCustomerNotesDto } from './dto/update-customer-notes.dto';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Patch(':id/notes')
  updateNotes(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerNotesDto) {
    return this.customersService.updateNotes(id, dto.notes);
  }
}
