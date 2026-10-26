import './globals.css'
import ServiceWorker from '@/ui/ServiceWorker'

// Police : Poppins, déclarée en @font-face dans globals.css (mêmes fichiers
// auto-hébergés que le site vitrine IFECARM GROUP, dans public/fonts).

export const metadata = {
  title: 'Plateforme QHSE — IFECARM GROUP',
  description: 'Inspections, non-conformités et plans d’action — espace clients et consultants IFECARM GROUP.',
  robots: { index: false, follow: false },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'IFECARM QHSE' },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#2d7a44',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  )
}
