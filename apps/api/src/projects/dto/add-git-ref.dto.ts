import { IsString, IsNotEmpty, IsOptional, IsIn, IsUUID } from 'class-validator';
import { GitRefType } from '@muneral/types';

export class AddGitRefDto {
  @IsUUID()
  taskId: string;

  @IsIn(['repo', 'branch', 'commit'])
  type: GitRefType;

  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsOptional()
  ref?: string;
}
