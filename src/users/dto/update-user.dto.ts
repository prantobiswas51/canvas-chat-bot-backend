import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';

// Password updates go through a dedicated endpoint later; keep it out of general PATCH for now.
export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['password'] as const)) {}
