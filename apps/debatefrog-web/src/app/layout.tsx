import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Debatefrog",
  description: "A playful debate interface powered by the Polyvise agent debate engine."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
