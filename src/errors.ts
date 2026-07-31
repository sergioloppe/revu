export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

export class SecurityViolationError extends Error {
  constructor(public reviewerId: string, detail: string) {
    super(`SECURITY: reviewer "${reviewerId}" mutated repository state. ${detail}`);
    this.name = 'SecurityViolationError';
  }
}

export class ToolError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolError'; }
}
