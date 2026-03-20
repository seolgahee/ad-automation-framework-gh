/**
 * Shared formatting utilities
 *
 * Centralizes locale-safe formatters to avoid repeated declarations
 * and ensure consistent formatting across all modules.
 */

/** Korean number formatter (locale-safe, no server locale dependency) */
export const krwFmt = new Intl.NumberFormat('ko-KR');

/** Format KRW amount with ₩ prefix */
export function fmtKRW(n) {
  return `₩${krwFmt.format(n)}`;
}
