import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class AssociateCommandBodyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsUUID()
  @IsOptional()
  parentId?: string;

  @IsUUID()
  @IsOptional()
  sprintId?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  priority?: string;

  @IsString()
  @IsOptional()
  contractDigest?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}

export class AssociateCommandDto {
  @IsIn(['task.create', 'task.create_child', 'run.associate'])
  operation!: 'task.create' | 'task.create_child' | 'run.associate';

  @IsUUID()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  idempotencyKey!: string;

  @ValidateNested()
  @Type(() => AssociateCommandBodyDto)
  command!: AssociateCommandBodyDto;

  @IsUUID()
  @IsOptional()
  rootTaskId?: string;

  @IsUUID()
  @IsOptional()
  runId?: string;
}
