import { redactSensitiveText } from './redaction';

export type LogLevelName = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * The five methods `vscode.LogOutputChannel` exposes, narrowed to the string
 * form this extension uses. Declared structurally (rather than importing the
 * VS Code type) so the modules that log keep their existing property of not
 * importing `vscode` at all, and so tests can hand them a plain recording
 * object.
 */
export interface LogSink {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  trace(message: string): void;
}

export type AtNacosLog = LogSink;

/**
 * ## What belongs at which level
 *
 * The channel is a `LogOutputChannel`, so VS Code owns the level (Output
 * panel gear icon / `Developer: Set Log Level...`) and supplies timestamps.
 * Its default is Info, which is what fixes the levels below:
 *
 * - `error`  -- an operation failed and the user has a broken thing in front
 *               of them: upstream request errors, tool invocation failures.
 * - `warn`   -- refused, shed, or truncated on purpose: a rejected request, a
 *               throttled call, a listing that hit its page guardrail.
 * - `info`   -- state transitions worth one line each: a server connection
 *               being established or torn down.
 * - `debug`  -- per-operation detail that is only useful once you are already
 *               debugging: retry attempts, API error classification.
 * - `trace`  -- per-request flow.
 *
 * Nothing on a healthy request path logs at `info` or above. Walking a
 * namespace issues a request per page of configurations; one line each would
 * turn the channel into a place nobody looks.
 *
 * ## Redaction is applied here, not at the call sites
 *
 * Every message is passed through `redactSensitiveText` on the way to the
 * sink. Doing it in one place is the point: a call site that interpolates an
 * upstream error, a URL, or a chunk of configuration content cannot forget,
 * and adding a new log line cannot introduce a leak. `redactSensitiveText` is
 * idempotent, so text that already went through `formatError` is unharmed.
 */
export function createRedactedLog(sink: LogSink): AtNacosLog {
  return {
    error: (message: string) => sink.error(redactSensitiveText(message)),
    warn: (message: string) => sink.warn(redactSensitiveText(message)),
    info: (message: string) => sink.info(redactSensitiveText(message)),
    debug: (message: string) => sink.debug(redactSensitiveText(message)),
    trace: (message: string) => sink.trace(redactSensitiveText(message))
  };
}

/**
 * The default for every component that takes an optional log. Logging is a
 * diagnostic aid, never a behavior: a component handed no channel must do
 * exactly what it did before this file existed.
 */
export const noopLog: AtNacosLog = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined
};

/**
 * What every component that accepts an optional log should call on its
 * argument, exactly once, in its constructor.
 *
 * `AtNacosLog` is structural, so nothing stops a caller from passing a raw
 * `LogOutputChannel` (or a test double) that has never been through
 * `createRedactedLog`. Re-wrapping here means the filtering is a property of
 * *holding* a log rather than of having composed one correctly at the single
 * place `extension.ts` builds it -- a new component, or a future call site
 * that forgets, cannot reintroduce the leak. `redactSensitiveText` is
 * idempotent, so the extra pass on an already-wrapped log costs a regex sweep
 * and changes nothing.
 */
export function asRedactedLog(log: AtNacosLog | undefined): AtNacosLog {
  return log === undefined || log === noopLog ? noopLog : createRedactedLog(log);
}
