export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
