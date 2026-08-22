import type { Metadata } from "next";
import { Barlow, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import ServiceWorker from "../components/ServiceWorker";
import "./globals.css";

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-barlow",
});

const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-barlow-condensed",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "Draft Cockpit",
  description: "Who to take, right now.",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${barlow.variable} ${barlowCondensed.variable} ${plexMono.variable}`}>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
