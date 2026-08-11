import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class CreateChecklistItemDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsNumber()
  @IsOptional()
  position?: number;
}
