import { IsString, IsNotEmpty, IsOptional, IsUUID, IsDateString } from 'class-validator';

export class CreateMilestoneDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsDateString()
  @IsOptional()
  dueDate?: string;
}
