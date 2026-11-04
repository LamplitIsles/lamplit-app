export class CompanionPreControllerError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "CompanionPreControllerError";
  }
}
