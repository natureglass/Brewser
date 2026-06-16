export class RuntimeError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'RuntimeError';
    }
}
export class ResourceError extends RuntimeError {
    constructor(message, options) {
        super(message, options);
        this.name = 'ResourceError';
    }
}
export class PermissionDeniedError extends RuntimeError {
    constructor(message, options) {
        super(message, options);
        this.name = 'PermissionDeniedError';
    }
}
//# sourceMappingURL=errors.js.map