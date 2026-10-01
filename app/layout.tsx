import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vaani Loan Service",
  description: "Entity-safe multilingual loan servicing voice agent",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
