import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeScript } from "@/components/site/theme-script";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Anvil Registry | Safer npm installs",
  description: "Anvil Registry and Anvil Node Base help teams inspect, explain, and enforce dependency policy before npm packages reach developers or CI.",
  metadataBase: new URL("https://anvil-registry.vercel.app"),
  openGraph: {
    title: "Anvil Registry | Forge safer npm installs",
    description: "A drop-in npm registry gateway and hardened Node base image for dependency security.",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Anvil Registry | Forge safer npm installs",
    description: "Open source dependency security for npm installs, CI, and devcontainers."
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>{children}</body>
    </html>
  );
}
