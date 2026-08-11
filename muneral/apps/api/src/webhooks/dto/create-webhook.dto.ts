import { IsString, IsNotEmpty, IsOptional, IsArray, IsUUID, IsUrl } from 'class-validator';

export class CreateWebhookDto {
  @IsUUID()
  workspaceId: string;

  @IsUrl()
  url: string;

  @IsArray()
  @IsString({ each: true })
  events: string[];

  @IsString()
  @IsOptional()
  secret?: string;
}
