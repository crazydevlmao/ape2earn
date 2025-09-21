import type { Metadata } from "next";
import "./globals.css";
import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ape2Earn | BANANA",
  description: "Ape2Earn $BANANA | The ultimate drop flywheel gamified experience.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable}`}>
      {/* Default to Inter across the app */}
      <body className="font-inter">{children}</body>
    </html>
  );
}
