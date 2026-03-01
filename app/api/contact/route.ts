import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { firstName, lastName, email, company, interest, message } = body;

    // Validate required fields
    if (!firstName || !lastName || !email || !message) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // In a real implementation, this would:
    // 1. Send an email notification
    // 2. Create a ticket in the support system
    // 3. Store the contact request in a database

    console.log('[Contact] New contact request:', {
      firstName,
      lastName,
      email,
      company,
      interest,
      message: message.substring(0, 100) + '...',
    });

    return NextResponse.json({
      success: true,
      message: 'Contact request received successfully',
    });
  } catch (error) {
    console.error('[Contact] Error processing request:', error);
    return NextResponse.json(
      { error: 'Failed to process contact request' },
      { status: 500 }
    );
  }
}
