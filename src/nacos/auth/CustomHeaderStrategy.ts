import type { NacosAuthStrategy } from './NacosAuthStrategy';

export class CustomHeaderStrategy implements NacosAuthStrategy {
  constructor(private readonly headers: Record<string, string>) {}

  /** A copy: a caller that edits the headers it was handed must not rewrite the stored credential. */
  async authHeaders(): Promise<Record<string, string>> {
    return { ...this.headers };
  }

  async refresh(): Promise<boolean> {
    // A static header cannot renew itself, so a 403 is a genuine permission
    // problem: the token the user pasted is wrong, expired at its own issuer,
    // or lacks the scope for this API.
    return false;
  }
}
