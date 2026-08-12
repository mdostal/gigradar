import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { NavHeader } from "./nav-header";

export const metadata: Metadata = {
  title: "gigradar",
  description: "Find and interact with fractional/contract engagements.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <NavHeader />
        {children}
      </body>
    </html>
  );
}
