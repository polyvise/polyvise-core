import type { Metadata } from "next";
import "./globals.css";

const isBetaDeploy = process.env.NEXT_PUBLIC_DEPLOY_CHANNEL === "beta";

export const metadata: Metadata = {
  title: "Debatefrog",
  description: "A playful debate interface powered by the Polyvise agent debate engine.",
  robots: isBetaDeploy
    ? {
        index: false,
        follow: false,
        googleBot: {
          index: false,
          follow: false
        }
      }
    : undefined
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
