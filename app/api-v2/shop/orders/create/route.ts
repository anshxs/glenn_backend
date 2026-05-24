import { NextRequest, NextResponse } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CreateOrderBody = {
  productId?: unknown;
  quantity?: unknown;
  name?: unknown;
  phone?: unknown;
  shippingAddress?: unknown;
  userNote?: unknown;
};

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<CreateOrderBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    const productId = cleanText(parsed.data.productId);
    const quantity =
      typeof parsed.data.quantity === 'number'
        ? parsed.data.quantity
        : Number.parseInt(parsed.data.quantity?.toString() ?? '', 10);
    const name = cleanText(parsed.data.name);
    const phone = cleanText(parsed.data.phone);
    const shippingAddress = cleanText(parsed.data.shippingAddress);
    const userNote = cleanText(parsed.data.userNote);

    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json(
        { error: 'Invalid order', message: 'Select a valid product quantity.' },
        { status: 400 },
      );
    }

    if (!name || !phone || !shippingAddress) {
      return NextResponse.json(
        { error: 'Missing details', message: 'Name, phone and address are required.' },
        { status: 400 },
      );
    }

    const { data: product, error: productError } = await supabaseAdmin
      .from('products')
      .select('id, name, selling_price, stock, is_active, requires_customization')
      .eq('id', productId)
      .single();

    if (productError || !product || product.is_active !== true) {
      return NextResponse.json(
        { error: 'Product unavailable', message: 'This product is not available.' },
        { status: 404 },
      );
    }

    if (Number(product.stock) < quantity) {
      return NextResponse.json(
        {
          error: 'Out of stock',
          message: `Only ${product.stock} item(s) are available.`,
        },
        { status: 400 },
      );
    }

    if (product.requires_customization === true && !userNote) {
      return NextResponse.json(
        {
          error: 'Missing customization',
          message: 'Customization details are required for this product.',
        },
        { status: 400 },
      );
    }

    const amountPaid = Number(product.selling_price) * quantity;

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('id, balance')
      .eq('user_id', auth.user.id)
      .single();

    if (walletError || !wallet) {
      return NextResponse.json(
        { error: 'Wallet unavailable', message: 'Could not load wallet.' },
        { status: 500 },
      );
    }

    if (Number(wallet.balance) < amountPaid) {
      return NextResponse.json(
        {
          error: 'Insufficient balance',
          message: `You need ₹${amountPaid.toFixed(2)} to buy this item.`,
        },
        { status: 400 },
      );
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: auth.user.id,
        product_id: productId,
        quantity,
        amount_paid: amountPaid,
        status: 'pending',
        shipping_address: shippingAddress,
        phone,
        name,
        user_note: userNote || null,
      })
      .select('*')
      .single();

    if (orderError || !order) {
      return NextResponse.json(
        {
          error: 'Order failed',
          message: orderError?.message ?? 'Could not create order.',
        },
        { status: 500 },
      );
    }

    const { error: walletUpdateError } = await supabaseAdmin
      .from('wallets')
      .update({
        balance: Number(wallet.balance) - amountPaid,
        last_updated: new Date().toISOString(),
      })
      .eq('id', wallet.id);

    if (walletUpdateError) {
      await supabaseAdmin.from('orders').delete().eq('id', order.id);
      return NextResponse.json(
        {
          error: 'Payment failed',
          message: walletUpdateError.message || 'Could not deduct wallet balance.',
        },
        { status: 500 },
      );
    }

    await supabaseAdmin
      .from('products')
      .update({ stock: Number(product.stock) - quantity })
      .eq('id', productId);

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data: {
        order,
        product_name: product.name,
        remaining_balance: Number(wallet.balance) - amountPaid,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Order failed',
        message:
          error instanceof Error ? error.message : 'Could not create order.',
      },
      { status: 500 },
    );
  }
}
