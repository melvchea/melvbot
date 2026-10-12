/** Thrown for a non-2xx HTTP response from a search or fetch provider. */
export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}
