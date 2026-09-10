/** Raised when a QWP payload is malformed, truncated, or unsupported. */
export class QwpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwpProtocolError";
  }
}
