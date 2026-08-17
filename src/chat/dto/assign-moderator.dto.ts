import { IsUUID } from 'class-validator';

export class AssignModeratorDto {
  @IsUUID()
  moderatorId: string;
}
