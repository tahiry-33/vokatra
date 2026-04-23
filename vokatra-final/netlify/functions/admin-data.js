// ============================================================
//  VOKATRA FIFIL — Netlify Function
//  admin-data.js
// ============================================================

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const BASE_HEADERS = {
  'apikey': SUPA_KEY,
  'Authorization': `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json',
};

async function supaFetch(path, params = '') {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}${params}`, { headers: BASE_HEADERS });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supaPatch(path, body) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...BASE_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? {} : r.json();
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = event.queryStringParameters?.token || event.headers['x-admin-token'];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non autorise' }) };
  }

  try {
    if (event.httpMethod === 'POST') {
      const action = event.queryStringParameters?.action;
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}

      if (action === 'mark_paid') {
        const { order_id, paid } = body;
        if (!order_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'order_id requis' }) };
        const newStatus = paid === false ? 'pending' : 'paid';
        await supaPatch(`orders?id=eq.${order_id}`, { payment_status: newStatus, updated_at: new Date().toISOString() });
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, order_id, payment_status: newStatus }) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Action inconnue' }) };
    }

    const type = event.queryStringParameters?.type || 'orders';

    if (type === 'orders') {
      const data = await supaFetch(
        'orders',
        '?select=id,created_at,updated_at,first_name,last_name,email,phone,address,total_cents,payment_method,payment_status,stripe_session_id,delivery_date&order=created_at.desc&limit=500'
      );
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (type === 'donations') {
      const data = await supaFetch(
        'donations',
        '?select=id,created_at,donor_first_name,donor_last_name,donor_email,donor_phone,church_name,section_name,message,amount_cents,payment_status,stripe_checkout_session_id&order=created_at.desc&limit=500'
      );
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (type === 'items') {
      const order_id = event.queryStringParameters?.order_id;
      if (!order_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'order_id requis' }) };
      const data = await supaFetch(
        'order_items',
        `?order_id=eq.${order_id}&select=product_name,quantity,unit_price_cents`
      );
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'type invalide' }) };
  } catch (e) {
    console.error('admin-data error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
