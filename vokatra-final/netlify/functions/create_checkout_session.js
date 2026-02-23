// ============================================================
//  VOKATRA – Netlify Function
//  create_checkout_session.js
//
//  Rôle : reçoit le panier + infos client du front,
//         valide tout côté serveur,
//         crée la commande en DB,
//         génère une session Stripe Checkout,
//         retourne l'URL de paiement.
// ============================================================

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// ── Clients ──────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // bypass RLS — sécurisé côté serveur uniquement
);

// ── Handler principal ─────────────────────────────────────────
exports.handler = async (event) => {

  // 1. Méthode POST uniquement
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return response(400, { error: 'Corps de requête invalide (JSON attendu)' });
  }

  const { cart, customer, delivery, donation } = body;

  // ────────────────────────────────────────────────────────────
  // CAS 1 : DON
  // ────────────────────────────────────────────────────────────
  if (donation) {
    return await handleDonation(donation);
  }

  // ────────────────────────────────────────────────────────────
  // CAS 2 : COMMANDE
  // ────────────────────────────────────────────────────────────
  return await handleOrder(cart, customer, delivery);
};


// ============================================================
//  COMMANDE
// ============================================================
async function handleOrder(cart, customer, delivery) {

  // ── Validation des champs obligatoires ──────────────────────
  const required = [
    'firstName', 'lastName', 'address',
    'churchName', 'sectionName',
    'deliveryAddress', 'deliveryDateId'
  ];
  for (const field of required) {
    if (!customer?.[field] && !delivery?.[field]) {
      const val = customer?.[field] ?? delivery?.[field.replace('delivery', '').toLowerCase()];
      if (!val) {
        // vérification combinée
      }
    }
  }
  if (!customer?.firstName)      return response(400, { error: 'Prénom obligatoire' });
  if (!customer?.lastName)       return response(400, { error: 'Nom obligatoire' });
  if (!customer?.address)        return response(400, { error: 'Adresse obligatoire' });
  if (!customer?.churchName)     return response(400, { error: 'Nom d\'église obligatoire' });
  if (!customer?.sectionName)    return response(400, { error: 'Section obligatoire' });
  if (!delivery?.address)        return response(400, { error: 'Adresse de livraison obligatoire' });
  if (!delivery?.dateId)         return response(400, { error: 'Date de livraison obligatoire' });
  if (!cart || !cart.length)     return response(400, { error: 'Panier vide' });

  // ── Validation de la date de livraison ──────────────────────
  const { data: deliveryDate, error: dateError } = await supabase
    .from('delivery_dates')
    .select('id, delivery_date, label, active')
    .eq('id', delivery.dateId)
    .single();

  if (dateError || !deliveryDate) {
    return response(400, { error: 'Date de livraison introuvable' });
  }
  if (!deliveryDate.active) {
    return response(400, { error: 'Cette date de livraison n\'est plus disponible' });
  }

  // ── Validation des produits (prix + stock côté serveur) ──────
  const productIds = cart.map(item => item.productId);

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, name, unit_price_cents, stock_qty, active, emoji')
    .in('id', productIds);

  if (productsError) {
    return response(500, { error: 'Erreur lors de la récupération des produits' });
  }

  // Construire les lignes de commande validées
  const orderItems = [];
  const stripeLineItems = [];
  let totalCents = 0;

  for (const cartItem of cart) {
    const product = products.find(p => p.id === cartItem.productId);

    if (!product) {
      return response(400, { error: `Produit introuvable : ${cartItem.productId}` });
    }
    if (!product.active) {
      return response(400, { error: `Produit non disponible : ${product.name}` });
    }
    if (product.stock_qty < cartItem.qty) {
      return response(400, {
        error: `Stock insuffisant pour "${product.name}". Disponible : ${product.stock_qty}, demandé : ${cartItem.qty}`
      });
    }
    if (cartItem.qty <= 0) {
      return response(400, { error: `Quantité invalide pour : ${product.name}` });
    }

    const lineTotalCents = product.unit_price_cents * cartItem.qty;
    totalCents += lineTotalCents;

    orderItems.push({
      product_id:                 product.id,
      product_name_snapshot:      product.name,
      product_emoji_snapshot:     product.emoji,
      unit_price_cents_snapshot:  product.unit_price_cents,
      qty:                        cartItem.qty,
      line_total_cents:           lineTotalCents,
    });

    stripeLineItems.push({
      price_data: {
        currency:     'eur',
        unit_amount:  product.unit_price_cents,
        product_data: {
          name:        product.name,
          description: `${product.emoji} Projet VOKATRA – FLM Bordeaux`,
        },
      },
      quantity: cartItem.qty,
    });
  }

  // ── Créer la commande en DB (payment_status = pending) ──────
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      status:               'new',
      payment_status:       'pending',
      payment_method:       'stripe',

      customer_first_name:  customer.firstName,
      customer_last_name:   customer.lastName,
      customer_address:     customer.address,
      customer_phone:       customer.phone   || null,
      customer_email:       customer.email   || null,

      church_name:          customer.churchName,
      section_name:         customer.sectionName,

      delivery_address:     delivery.address,
      delivery_date_id:     delivery.dateId,

      currency:             'EUR',
      total_amount_cents:   totalCents,
    })
    .select('id')
    .single();

  if (orderError) {
    console.error('Erreur création commande:', orderError);
    return response(500, { error: 'Erreur lors de la création de la commande' });
  }

  // ── Créer les lignes de commande ────────────────────────────
  const itemsWithOrderId = orderItems.map(item => ({
    ...item,
    order_id: order.id,
  }));

  const { error: itemsError } = await supabase
    .from('order_items')
    .insert(itemsWithOrderId);

  if (itemsError) {
    console.error('Erreur création order_items:', itemsError);
    // Annuler la commande orpheline
    await supabase.from('orders').delete().eq('id', order.id);
    return response(500, { error: 'Erreur lors de l\'enregistrement des articles' });
  }

  // ── Créer la session Stripe Checkout ────────────────────────
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      line_items:           stripeLineItems,

      // Métadonnées pour le webhook
      metadata: {
        order_id: order.id,
        type:     'order',
      },

      customer_email: customer.email || undefined,

      success_url: `${process.env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/cancel`,

      // Expiration : 30 minutes
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    });
  } catch (stripeError) {
    console.error('Erreur Stripe:', stripeError);
    // Mettre la commande en failed
    await supabase
      .from('orders')
      .update({ payment_status: 'failed' })
      .eq('id', order.id);
    return response(500, { error: 'Erreur lors de la création du paiement Stripe' });
  }

  // ── Enregistrer l'ID de session Stripe ──────────────────────
  await supabase
    .from('orders')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', order.id);

  // ── Retourner l'URL de paiement ─────────────────────────────
  return response(200, {
    url:      session.url,
    order_id: order.id,
  });
}


// ============================================================
//  DON
// ============================================================
async function handleDonation(donation) {

  // Validation
  if (!donation.firstName)  return response(400, { error: 'Prénom obligatoire' });
  if (!donation.lastName)   return response(400, { error: 'Nom obligatoire' });
  if (!donation.amountCents || donation.amountCents < 100) {
    return response(400, { error: 'Montant minimum : 1 €' });
  }

  // Créer le don en DB
  const { data: don, error: donError } = await supabase
    .from('donations')
    .insert({
      donor_first_name: donation.firstName,
      donor_last_name:  donation.lastName,
      donor_email:      donation.email    || null,
      donor_phone:      donation.phone    || null,
      church_name:      donation.church   || null,
      section_name:     donation.section  || null,
      message:          donation.message  || null,
      amount_cents:     donation.amountCents,
      currency:         'EUR',
      payment_status:   'pending',
    })
    .select('id')
    .single();

  if (donError) {
    console.error('Erreur création don:', donError);
    return response(500, { error: 'Erreur lors de la création du don' });
  }

  // Créer la session Stripe
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      line_items: [{
        price_data: {
          currency:    'eur',
          unit_amount: donation.amountCents,
          product_data: {
            name:        `Don – Projet VOKATRA`,
            description: `FLM Bordeaux · Merci pour votre soutien 🙏`,
          },
        },
        quantity: 1,
      }],
      metadata: {
        donation_id: don.id,
        type:        'donation',
      },
      customer_email: donation.email || undefined,
      success_url: `${process.env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/cancel`,
    });
  } catch (stripeError) {
    console.error('Erreur Stripe don:', stripeError);
    await supabase.from('donations').delete().eq('id', don.id);
    return response(500, { error: 'Erreur Stripe' });
  }

  // Enregistrer l'ID de session
  await supabase
    .from('donations')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', don.id);

  return response(200, {
    url:         session.url,
    donation_id: don.id,
  });
}


// ── Helpers ───────────────────────────────────────────────────
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
