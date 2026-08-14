export interface Money {
  readonly minor: number;
  readonly currency: "INR" | "USD";
}

const SYMBOL: Record<Money["currency"], string> = { INR: "₹", USD: "$" };
const EXPONENT: Record<Money["currency"], number> = { INR: 2, USD: 2 };

export function money(minor: number, currency: Money["currency"]): Money {
  if (!Number.isInteger(minor)) {
    throw new Error(`money() requires integer minor units, got ${minor}`);
  }
  return { minor, currency };
}

export function formatMoney(m: Money): string {
  const div = 10 ** EXPONENT[m.currency];
  return `${SYMBOL[m.currency]}${(m.minor / div).toFixed(EXPONENT[m.currency])}`;
}
