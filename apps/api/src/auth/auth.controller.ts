import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { GithubOAuthGuard } from './guards/github-oauth.guard';
import { TelegramLoginDto } from './dto/telegram-login.dto';
import { User } from '../common/entities/user.entity';
import { Throttle } from '@nestjs/throttler';

/**
 * Authentication controller — GitHub OAuth and Telegram Login Widget.
 * All auth endpoints are rate-limited to 5 req/min.
 */
@Controller('auth')
@Throttle({ default: { limit: 5, ttl: 60000 } })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Initiate GitHub OAuth flow */
  @Get('github')
  @UseGuards(GithubOAuthGuard)
  githubAuth(): void {
    // Passport redirects — no body needed
  }

  /** GitHub OAuth callback — issue JWT pair */
  @Get('github/callback')
  @UseGuards(GithubOAuthGuard)
  githubCallback(@Req() req: Request & { user: User }): {
    access_token: string;
    refresh_token: string;
  } {
    const user = req.user;
    return {
      access_token: this.authService.signAccess(user.id),
      refresh_token: this.authService.signRefresh(user.id),
    };
  }

  /** Telegram Login Widget — verify HMAC and issue JWT pair */
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  async telegramLogin(@Body() dto: TelegramLoginDto): Promise<{
    access_token: string;
    refresh_token: string;
  }> {
    const valid = this.authService.verifyTelegramLogin(dto);
    if (!valid) {
      throw new BadRequestException('Invalid Telegram auth data');
    }
    const user = await this.authService.findOrCreateTelegramUser(dto);
    return {
      access_token: this.authService.signAccess(user.id),
      refresh_token: this.authService.signRefresh(user.id),
    };
  }
}
