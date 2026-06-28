import './globals.css';

export const metadata = {
  title: 'Quietly',
  description: 'A calm, private space to write — and slowly build a picture of your mind.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
