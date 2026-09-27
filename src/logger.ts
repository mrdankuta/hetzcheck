/**
 * Minimal, dependency-free logger with timestamps and ANSI colors.
 *
 * Colors are used to make the console output easy to scan:
 *  - info  -> default
 *  - warn  -> yellow
 *  - error -> red
 *  - success (the "big green banner") -> bright green
 */

const Colors = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  greenBright: '\x1b[92m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
} as const;

/**
 * Formats a Date as "YYYY-MM-DD HH:mm" in local time.
 */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function stamp(): string {
  return `${Colors.gray}[${formatTimestamp()}]${Colors.reset}`;
}

export const logger = {
  info(message: string): void {
    console.log(`${stamp()} ${message}`);
  },

  warn(message: string): void {
    console.warn(`${stamp()} ${Colors.yellow}${message}${Colors.reset}`);
  },

  error(message: string): void {
    console.error(`${stamp()} ${Colors.red}${message}${Colors.reset}`);
  },

  /**
   * Prints the large green "CX33 AVAILABLE!" banner, including hardware specs
   * and price when they are provided.
   */
  availableBanner(
    serverType: string,
    location: string,
    when: string,
    specLines: string[] = [],
  ): void {
    const line = '===================================';
    const banner = [
      '',
      line,
      `${serverType.toUpperCase()} AVAILABLE!`,
      `Location: ${location}`,
      ...specLines,
      `Time: ${when}`,
      line,
      '',
    ].join('\n');

    console.log(`${Colors.bold}${Colors.greenBright}${banner}${Colors.reset}`);
  },
};
