import { IsString } from 'class-validator';

export class UpdateCustomerNotesDto {
  // Empty string is a valid way to clear the note — not @IsOptional.
  @IsString()
  notes: string;
}
