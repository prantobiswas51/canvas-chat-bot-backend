import { IsOptional, IsUUID } from 'class-validator';

export class AssignModeratorDto {
  // Omitted or null hands the conversation back to the AI (see
  // ChatService.assignModerator) — @IsOptional() skips validation for both
  // undefined and null, so a real value still has to be a valid UUID.
  @IsOptional()
  @IsUUID()
  moderatorId?: string | null;
}
