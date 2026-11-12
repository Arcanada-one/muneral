import { IsString, IsNotEmpty } from 'class-validator';

export class AddCommentDto {
  @IsString()
  @IsNotEmpty()
  body: string;
}
// probe 19f7d9aa: comment-only change on a scratch branch, never merge
