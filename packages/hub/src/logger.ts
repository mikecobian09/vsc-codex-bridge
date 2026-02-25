export class Logger {
  public constructor(private readonly verbose: boolean) {}

  public info(message: string): void {
    this.print("INFO", message);
  }

  public warn(message: string): void {
    this.print("WARN", message);
  }

  public error(message: string): void {
    this.print("ERROR", message);
  }

  public debug(message: string): void {
    if (!this.verbose) {
      return;
    }
    this.print("DEBUG", message);
  }

  private print(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): void {
    const ts = new Date().toISOString();
    const output = `[${ts}] [${level}] ${this.redact(message)}`;

    if (level === "ERROR") {
      console.error(output);
      return;
    }

    console.log(output);
  }

  /**
   * Redacts common secret-bearing patterns from log messages.
   *
   * This protects accidental token disclosure from:
   * - Authorization headers (`Bearer ...`)
   * - URL query tokens (`?token=...`)
   * - JSON config payload fields (`"authToken":"..."`)
   */
  private redact(message: string): string {
    return String(message)
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***REDACTED***")
      .replace(/([?&]token=)[^&\s]+/gi, "$1***REDACTED***")
      .replace(/("authToken"\s*:\s*")[^"]+(")/gi, '$1***REDACTED***$2');
  }
}
