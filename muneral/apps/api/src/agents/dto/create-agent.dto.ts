import { IsString, IsNotEmpty, IsOptional, IsUUID, IsObject } from 'class-validator';

export class CreateAgentDto {
  @IsUUID()
  workspaceId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  model?: string;

  @IsString()
  @IsOptional()
  provider?: string;

  @IsObject()
  @IsOptional()
  capabilities?: Record<string, unknown>;
}
