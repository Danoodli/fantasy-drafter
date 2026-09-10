import type { Metadata } from "next";
import { Barlow, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import ServiceWorker from "../components/ServiceWorker";
import AppBar from "../components/shell/AppBar";
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
    <html lang="en" suppressHydrationWarning>
      <body className={`${barlow.variable} ${barlowCondensed.variable} ${plexMono.variable}`}>
        <script
          // Runs before paint so a light-theme user never sees a dark flash.
          // Mirrors lib/client/theme.ts: saved id if valid, else by colour scheme.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var k="draft-cockpit-theme-v1",v=localStorage.getItem(k),ok=["night","day","prime","throwback"];if(ok.indexOf(v)<0){v=window.matchMedia("(prefers-color-scheme: light)").matches?"day":"night"}document.documentElement.dataset.theme=v;document.documentElement.style.colorScheme=(v==="day"||v==="throwback")?"light":"dark"}catch(e){}})();`,
          }}
        />
        <AppBar />
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
