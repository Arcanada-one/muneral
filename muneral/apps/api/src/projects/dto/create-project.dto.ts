import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';

export class CreateProjectDto {
  @IsUUID()
  workspaceId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[a-z0-9-]+$/, { message: 'Slug: lowercase, numbers, hyphens only' })
  slug: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  repoUrl?: string;
}
