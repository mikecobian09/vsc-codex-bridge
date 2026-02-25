/**
 * Minimal logger channel contract used by the bridge.
 *
 * Note:
 * We intentionally avoid importing runtime `vscode` module here so this class
 * can be reused from Node-based tests without VS Code host runtime.
 */
export interface LoggerOutputChannel {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export class Logger {
  private verbose = false;

  constructor(private readonly output: LoggerOutputChannel, verbose = false) {
    this.verbose = verbose;
  }

  public setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  public info(message: string): void {
    this.output.appendLine(this.format("INFO", message));
  }

  public warn(message: string): void {
    this.output.appendLine(this.format("WARN", message));
  }

  public error(message: string): void {
    this.output.appendLine(this.format("ERROR", message));
  }

  public debug(message: string): void {
    if (!this.verbose) {
      return;
    }
    this.output.appendLine(this.format("DEBUG", message));
  }

  public show(): void {
    this.output.show(true);
  }

  public dispose(): void {
    this.output.dispose();
  }

  private format(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): string {
    return `[${new Date().toISOString()}] [${level}] ${message}`;
  }
}
