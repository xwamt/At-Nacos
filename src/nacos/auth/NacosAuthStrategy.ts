export interface NacosAuthStrategy {
  /** The headers every request carries. Logging in and renewing happen behind this call. */
  authHeaders(): Promise<Record<string, string>>;
  /**
   * Called after an HTTP 403. `true` means the credential has been renewed or
   * discarded and the caller should retry once; `false` means this strategy
   * cannot recover on its own, so a retry would only repeat the failure.
   */
  refresh(): Promise<boolean>;
}
