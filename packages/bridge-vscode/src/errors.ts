export type BridgeErrorCode = "NOT_FOUND" | "BUSY" | "INVALID_STATE" | "INVALID_INPUT";

export class BridgeStoreError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeStoreError";
  }
}
