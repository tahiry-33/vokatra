// ============================================================
//  VOKATRA FIFIL — Netlify Function
//  create_checkout_session.js
//
//  Rôle : reçoit un order_id (commande déjà créée via RPC place_order)
//         OU un donation_id (don déjà inséré en DB).
//         Crée la session Stripe Checkout correspondante
//         et renvoie l'URL de paiement.
// ============================================================

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SITE_URL = process.env.SITE_URL || 'https://vokatra-fifil.netlify.app';

// ── Handler principal ─────────────────────────────────────────
exports.handler = async (event) => {

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return json(400, { error: 'Corps JSON invalide' }); }

  // ─────────────────────────────────────────────
  // Type DON
  // ─────────────────────────────────────────────
  if (body.type === 'donation' || body.donation_id) {
    return await handleDonation(body);
  }

  // ─────────────────────────────────────────────
  // Type COMMANDE
  // ─────────────────────────────────────────────
  return await handleOrder(body);
};


// ============================================================
//  COMMANDE
// ============================================================
async function handleOrder({ order_id, church_name }) {
  if (!order_id) return json(400, { error: 'order_id manquant' });

  // Récupérer la commande
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, first_name, last_name, email, total_cents, payment_status, payment_method')
    .eq('id', order_id)
    .single();

  if (orderErr || !order) {
    console.error('Order introuvable:', orderErr);
    return json(404, { error: 'Commande introuvable' });
  }

  if (order.payment_status === 'paid') {
    return json(400, { error: 'Commande déjà payée' });
  }

  if (order.payment_method !== 'stripe') {
    return json(400, { error: 'Cette commande n\'est pas en mode Stripe' });
  }

  // Récupérer les items
  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('product_name, product_id, quantity, unit_price_cents')
    .eq('order_id', order_id);

  if (itemsErr || !items || !items.length) {
    console.error('Items introuvables:', itemsErr);
    return json(404, { error: 'Articles de la commande introuvables' });
  }

  // Construire les line_items Stripe
  const churchLabel = church_name || 'FIFIL Fileovana Paris';
  const lineItems = items.map(it => ({
    price_data: {
      currency: 'eur',
      unit_amount: it.unit_price_cents,
      product_data: {
        name: it.product_name,
        description: `Projet Vokatra — ${churchLabel}`
      }
    },
    quantity: it.quantity
  }));

  // Créer la session Stripe
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      customer_email: order.email || undefined,
      metadata: {
        order_id: order.id,
        type: 'order'
      },
      success_url: `${SITE_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/?payment=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 1800 // 30 min
    });
  } catch (stripeErr) {
    console.error('Erreur Stripe:', stripeErr);
    await supabase.from('orders').update({ payment_status: 'failed' }).eq('id', order.id);
    return json(500, { error: 'Erreur lors de la création du paiement' });
  }

  // Enregistrer l'ID de session Stripe dans la commande
  await supabase
    .from('orders')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', order.id);

  return json(200, {
    checkout_url: session.url,
    order_id: order.id
  });
}


// ============================================================
//  DON
// ============================================================
async function handleDonation({ donation_id, amount_cents, church_name }) {
  if (!donation_id) return json(400, { error: 'donation_id manquant' });
  if (!amount_cents || amount_cents < 100) return json(400, { error: 'Montant invalide' });

  // Récupérer le don
  const { data: don, error: donErr } = await supabase
    .from('donations')
    .select('id, donor_first_name, donor_last_name, donor_email, amount_cents, payment_status')
    .eq('id', donation_id)
    .single();

  if (donErr || !don) {
    console.error('Don introuvable:', donErr);
    return json(404, { error: 'Don introuvable' });
  }

  if (don.payment_status === 'paid') {
    return json(400, { error: 'Don déjà payé' });
  }

  const churchLabel = church_name || 'FIFIL Fileovana Paris';

  // Créer la session Stripe pour don
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: don.amount_cents || amount_cents,
          product_data: {
            name: `Don — Projet Vokatra`,
            description: `${churchLabel} · Merci pour votre soutien 🙏`
          }
        },
        quantity: 1
      }],
      customer_email: don.donor_email || undefined,
      metadata: {
        donation_id: don.id,
        type: 'donation'
      },
      success_url: `${SITE_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/?payment=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 1800
    });
  } catch (stripeErr) {
    console.error('Erreur Stripe don:', stripeErr);
    await supabase.from('donations').update({ payment_status: 'failed' }).eq('id', don.id);
    return json(500, { error: 'Erreur Stripe' });
  }

  await supabase
    .from('donations')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', don.id);

  return json(200, {
    checkout_url: session.url,
    donation_id: don.id
  });
}


// ── Helpers ───────────────────────────────────────────────────
function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}
