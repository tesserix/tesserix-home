import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'healthy',
    service: 'tesserix-home',
    timestamp: new Date().toISOString(),
  });
}
