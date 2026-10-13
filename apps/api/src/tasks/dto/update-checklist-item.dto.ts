import { IsBoolean } from 'class-validator';

export class UpdateChecklistItemDto {
  @IsBoolean()
  checked!: boolean;
}
