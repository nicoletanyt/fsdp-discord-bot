export function clip(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  // Decode only complete UTF-8 characters.
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, bytes))
    .replace(/\uFFFD$/u, '');
}

export function makeRedactor(secrets: string[]) {
  const values = secrets.filter(x => x.length >= 6).sort((a, b) => b.length - a.length);
  return (text: string): string => {
    for (const value of values) text = text.split(value).join('[REDACTED]');
    return text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:AIza[\w-]{30,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-[\w-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
      .replace(/((?:api[_-]?key|secret|password|authorization|access[_-]?token|discord[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@');
  };
}

export function secretPath(path: string): boolean {
  return path.split(/[\\/]/).some(part =>
    /^(?:\.git|\.pi|\.env(?:\..*)?|node_modules|\.ssh|\.aws|\.npmrc|\.netrc|\.gitmodules)$/i.test(part)
    || /(?:credential|secret|private[-_]?key)/i.test(part)
    || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(part));
}

export class RequestBudget {
  calls = 0;
  readonly readFiles = new Set<string>();
  readonly discoveredFiles = new Set<string>();
  readonly discordAnchors = new Map<string, string>();
  discordCount = 0;
  discordBytes = 0;
  constructor(readonly maxCalls: number, readonly maxFiles: number) {}
  claimTool() {
    if (this.calls >= this.maxCalls) throw new Error('Tool budget exhausted');
    this.calls++;
  }
  claimRead(path: string) {
    if (!this.discoveredFiles.has(path)) throw new Error('Search for this file before reading it');
    if (!this.readFiles.has(path) && this.readFiles.size >= this.maxFiles) throw new Error('Repository file budget exhausted');
    this.readFiles.add(path);
  }
}
