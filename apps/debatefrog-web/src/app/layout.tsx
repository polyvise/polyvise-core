import type { Metadata } from "next";
import "./globals.css";

const isPreviewDeploy = process.env.NEXT_PUBLIC_DEPLOY_CHANNEL === "preview";

export const metadata: Metadata = {
  title: "Debatefrog",
  description: "A playful debate interface powered by the Polyvise agent debate engine.",
  robots: isPreviewDeploy
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
