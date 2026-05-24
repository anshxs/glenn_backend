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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_BODY_KEYS = new Set([
  'productId',
  'quantity',
  'name',
  'phone',
  'shippingAddress',
  'userNote',
]);

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasOnlyAllowedKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => ALLOWED_BODY_KEYS.has(key));
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

    if (!hasOnlyAllowedKeys(parsed.data as Record<string, unknown>)) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Unsupported order fields.' },
        { status: 400 },
      );
    }

    if (
      !UUID_RE.test(productId) ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > 10
    ) {
      return NextResponse.json(
        { error: 'Invalid order', message: 'Select a valid product quantity.' },
        { status: 400 },
      );
    }

    if (
      !name ||
      !phone ||
      !shippingAddress ||
      name.length > 80 ||
      phone.length > 20 ||
      shippingAddress.length > 500 ||
      userNote.length > 300
    ) {
      return NextResponse.json(
        {
          error: 'Invalid details',
          message: 'Enter valid name, phone and address details.',
        },
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
        {
          error: 'Product unavailable',
          message: 'This product is not available.',
        },
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
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return NextResponse.json(
        { error: 'Invalid product price', message: 'Product price is invalid.' },
        { status: 400 },
      );
    }

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

    const { data: updatedWallet, error: walletUpdateError } =
      await supabaseAdmin
        .from('wallets')
        .update({
          balance: Number(wallet.balance) - amountPaid,
          last_updated: new Date().toISOString(),
        })
        .eq('id', wallet.id)
        .gte('balance', amountPaid)
        .select('balance')
        .maybeSingle();

    if (walletUpdateError || !updatedWallet) {
      return NextResponse.json(
        {
          error: 'Payment failed',
          message: 'Wallet balance is not enough for this order.',
        },
        { status: 400 },
      );
    }

    const { data: updatedProduct, error: stockUpdateError } =
      await supabaseAdmin
        .from('products')
        .update({ stock: Number(product.stock) - quantity })
        .eq('id', productId)
        .gte('stock', quantity)
        .select('stock')
        .maybeSingle();

    if (stockUpdateError || !updatedProduct) {
      await supabaseAdmin
        .from('wallets')
        .update({
          balance: Number(updatedWallet.balance) + amountPaid,
          last_updated: new Date().toISOString(),
        })
        .eq('id', wallet.id);

      return NextResponse.json(
        {
          error: 'Out of stock',
          message: 'This product just went out of stock.',
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
      await supabaseAdmin
        .from('wallets')
        .update({
          balance: Number(updatedWallet.balance) + amountPaid,
          last_updated: new Date().toISOString(),
        })
        .eq('id', wallet.id);
      await supabaseAdmin
        .from('products')
        .update({ stock: Number(updatedProduct.stock) + quantity })
        .eq('id', productId);

      return NextResponse.json(
        {
          error: 'Order failed',
          message: orderError?.message ?? 'Could not create order.',
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data: {
        order,
        product_name: product.name,
        remaining_balance: Number(updatedWallet.balance),
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
