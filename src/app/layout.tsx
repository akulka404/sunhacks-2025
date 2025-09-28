import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'CrisisVerse v1.0',
  description: 'CrisisVerse v1.0 — Start a simulation powered by OpenAI',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
