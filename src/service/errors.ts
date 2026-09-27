import type { FailureCode } from "../shared/protocol";

export class StoreError extends Error {
  constructor(
    public code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
