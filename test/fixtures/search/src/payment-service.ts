export function chargeCustomer(customerId: string, amountCents: number): string {
  return `charged-${customerId}-${amountCents}`;
}
