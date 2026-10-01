import type { Loan } from "./domain";

const demoLoan: Loan = {
  accountNumberMasked: "•••• 4821",
  product: "Personal Loan",
  monthlyEmi: 15000,
  dueDate: "2026-10-05",
  outstandingBalance: 184500,
  status: "current",
};

export async function verifyOtp(otp: string) {
  return otp.replace(/\D/g, "") === "482931";
}

export async function getLoanSummary(): Promise<Loan> {
  return demoLoan;
}

export async function createPaymentLink(loan: Loan) {
  return {
    amount: loan.monthlyEmi,
    link: `https://pay.example.test/loan/${loan.accountNumberMasked.replace(/\D/g, "")}`,
    expiresAt: "2026-10-05T23:59:59+05:30",
  };
}
