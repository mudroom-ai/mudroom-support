// The person a question is asked for (the requester). Copied from the gateway's booking
// code unchanged in behaviour: name plus a valid phone or email. T4b maps the support
// request's `requester: { name, email }` (email required) onto this shape.

export interface Customer {
  name: string;
  phone?: string;
  email?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function normalizeCustomer(c: unknown): Customer {
  const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  const out: Customer = { name: str(o.name) };
  const phone = str(o.phone);
  const email = str(o.email).toLowerCase();
  if (phone) out.phone = phone;
  if (email) out.email = email;
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]+$/;

/** Name plus at least one valid phone or email. Returns an error message or null. */
export function validateCustomer(c: Customer): string | null {
  if (!c.name) return "customer.name is required";
  if (c.name.length > 200) return "customer.name is too long (max 200)";
  if (!c.phone && !c.email) return "customer needs a phone or an email";
  if (c.email && (c.email.length > 254 || !EMAIL.test(c.email))) return "customer.email is not a valid email address";
  if (c.phone) {
    const digits = c.phone.replace(/\D/g, "").length;
    if (!PHONE.test(c.phone) || digits < 7 || digits > 15) return "customer.phone is not a valid phone number";
  }
  return null;
}
