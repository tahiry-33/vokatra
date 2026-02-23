// ============================================================
//  VOKATRA – Netlify Function
//  stripe_webhook.js
//
//  Rôle : reçoit les événements Stripe,
//         vérifie la signature (sécurité),
//         confirme la commande ou le don,
//         décrémente le stock via RPC atomique.
// ============================================================

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Handler principal ─────────────────────────────────────────
exports.handler = async (event) => {

  // 1. POST uniquement
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // 2. Vérification de la signature Stripe (CRITIQUE sécurité)
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,                           // body brut (non parsé)
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Signature Stripe invalide:', err.message);
    return {
      statusCode: 400,
      body: `Webhook signature invalide : ${err.message}`,
    };
  }

  console.log(`✅ Événement Stripe reçu : ${stripeEvent.type}`);

  // 3. Router selon le type d'événement
  try {
    switch (stripeEvent.type) {

      // ── Paiement confirmé ────────────────────────────────────
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        await handlePaymentConfirmed(session);
        break;
      }

      // ── Session expirée (30 min sans paiement) ───────────────
      case 'checkout.session.expired': {
        const session = stripeEvent.data.object;
        await handlePaymentFailed(session.id);
        break;
      }

      // ── Paiement échoué ──────────────────────────────────────
      case 'payment_intent.payment_failed': {
        const paymentIntent = stripeEvent.data.object;
        // Chercher la session liée si possible
        if (paymentIntent.metadata?.session_id) {
          await handlePaymentFailed(paymentIntent.metadata.session_id);
        }
        break;
      }

      // ── Remboursement ────────────────────────────────────────
      case 'charge.refunded': {
        const charge = stripeEvent.data.object;
        await handleRefund(charge);
        break;
      }

      default:
        console.log(`Événement ignoré : ${stripeEvent.type}`);
    }
  } catch (err) {
    console.error('❌ Erreur traitement webhook:', err);
    // Retourner 200 quand même pour éviter que Stripe réessaie
    // (l'erreur est loggée, à investiguer manuellement)
    return { statusCode: 200, body: 'Webhook reçu avec erreur interne' };
  }

  // 4. Toujours répondre 200 à Stripe (sinon il réessaie)
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};


// ============================================================
//  PAIEMENT CONFIRMÉ
// ============================================================
async function handlePaymentConfirmed(session) {
  const sessionId     = session.id;
  const paymentIntent = session.payment_intent;
  const type          = session.metadata?.type; // 'order' ou 'donation'

  console.log(`💳 Paiement confirmé - session: ${sessionId} - type: ${type}`);

  if (type === 'order') {
    // Appeler la RPC atomique (confirm + décrément stock)
    const { data, error } = await supabase.rpc('confirm_order_payment', {
      p_stripe_session_id:     sessionId,
      p_stripe_payment_intent: paymentIntent,
    });

    if (error) {
      console.error('❌ Erreur RPC confirm_order_payment:', error);
      throw error;
    }

    if (!data?.success) {
      console.warn('⚠️ confirm_order_payment retourne success=false:', data);
      // Pas une erreur critique (peut être déjà traité = idempotence)
    } else {
      console.log(`✅ Commande confirmée : ${data.order_id}`);
    }

  } else if (type === 'donation') {
    const { data, error } = await supabase.rpc('confirm_donation_payment', {
      p_stripe_session_id:     sessionId,
      p_stripe_payment_intent: paymentIntent,
    });

    if (error) {
      console.error('❌ Erreur RPC confirm_donation_payment:', error);
      throw error;
    }

    if (data?.success) {
      console.log(`✅ Don confirmé : ${data.donation_id}`);
    }

  } else {
    console.warn(`⚠️ Type inconnu dans metadata: ${type}`);
  }
}


// ============================================================
//  PAIEMENT ÉCHOUÉ / SESSION EXPIRÉE
// ============================================================
async function handlePaymentFailed(sessionId) {
  console.log(`❌ Paiement échoué - session: ${sessionId}`);

  const { data, error } = await supabase.rpc('mark_payment_failed', {
    p_stripe_session_id: sessionId,
  });

  if (error) {
    console.error('❌ Erreur RPC mark_payment_failed:', error);
    throw error;
  }

  console.log(`✅ Statut mis à jour : failed pour session ${sessionId}`);
}


// ============================================================
//  REMBOURSEMENT
// ============================================================
async function handleRefund(charge) {
  // Retrouver la commande via le payment_intent
  const paymentIntentId = charge.payment_intent;

  if (!paymentIntentId) return;

  const { error } = await supabase
    .from('orders')
    .update({
      payment_status: 'refunded',
      updated_at:     new Date().toISOString(),
    })
    .eq('stripe_payment_intent_id', paymentIntentId);

  if (error) {
    console.error('❌ Erreur mise à jour remboursement:', error);
  } else {
    console.log(`✅ Remboursement enregistré pour payment_intent: ${paymentIntentId}`);
  }
}
