import './globals.css';

export const metadata = {
  title: 'NeuroTwin',
  description: 'A calm journal app with a simple FastAPI backend',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
