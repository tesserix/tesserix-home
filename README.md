# Tesserix Home

Platform frontend application for Tesserix. Built with Next.js 16, React 19, and Tailwind CSS. Serves the admin dashboard, marketing pages, and authentication flows.

## Features

- **Admin Dashboard**: Comprehensive admin panel with 15+ sections
- **Marketing Pages**: Public-facing marketing and landing pages
- **Authentication**: Login and auth callback flows (via auth-bff)
- **Rich Text Editing**: TipTap editor for content management
- **Design System**: Uses @tesserix/web and @tesserix/hooks packages
- **Form Validation**: react-hook-form with Zod schema validation
- **Data Fetching**: TanStack React Query for server state management
- **Animations**: Framer Motion for transitions and interactions
- **E2E Testing**: Playwright test suite

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| UI Library | React 19 |
| Styling | Tailwind CSS |
| Components | Radix UI, @tesserix/web |
| Data Fetching | TanStack React Query |
| Forms | react-hook-form + Zod |
| Rich Text | TipTap |
| Animations | Framer Motion |
| Icons | Lucide React |
| Testing | Playwright |
| Deployment | Cloud Run |

## App Structure

```
app/
├── (marketing)/       # Public marketing pages
├── admin/             # Admin dashboard (15+ sections)
├── api/               # Next.js API route handlers
├── auth/              # Authentication pages
├── login/             # Login page
├── layout.tsx         # Root layout
├── globals.css        # Global styles
├── error.tsx          # Error boundary
├── not-found.tsx      # 404 page
├── robots.ts          # robots.txt generation
└── sitemap.ts         # sitemap.xml generation
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL |
| `NEXT_PUBLIC_AUTH_BFF_URL` | Auth BFF service URL |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |

## Getting Started

```bash
# Install dependencies
npm install

# Run development server (port 3002)
npm run dev

# Build for production
npm run build

# Run E2E tests
npm run test:e2e
```

## License

Proprietary - Tesserix
