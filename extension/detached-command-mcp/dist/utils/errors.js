export class UserError extends Error {
    constructor(message) {
        super(message);
        this.name = "UserError";
    }
}
export function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
//# sourceMappingURL=errors.js.map