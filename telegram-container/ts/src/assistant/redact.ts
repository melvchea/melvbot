const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+\d{1,3}(?:[\s-]?\d){6,14}/g;

/** Masks emails and phone-like numbers before text is placed in a model prompt. */
export function redactForPrompt(text: string): string {
  return text.replace(EMAIL_RE, "[redacted-email]").replace(PHONE_RE, "[redacted-phone]");
}
