import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-github2';
import { AuthService } from '../auth.service';
import { GithubProfile } from '../dto/github-profile.dto';
import { User } from '../../common/entities/user.entity';

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(private readonly authService: AuthService) {
    super({
      clientID: process.env.GITHUB_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
      callbackURL:
        process.env.GITHUB_CALLBACK_URL ??
        'https://api.muneral.com/auth/github/callback',
      scope: ['user:email'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: GithubProfile,
    done: (err: unknown, user: User | false) => void,
  ): Promise<void> {
    try {
      const user = await this.authService.findOrCreateGithubUser(profile);
      done(null, user);
    } catch (err) {
      done(err, false);
    }
  }
}
