const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

async function supaFetch(path, params = '') {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}${params}`, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
    }
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = event.queryStringParameters?.token || event.headers['x-admin-token'];
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non autorise' }) };
  }

  try {
    const type = event.queryStringParameters?.type || 'orders';

    if (type === 'orders') {
      const data = await supaFetch('orders',
        '?select=id,created_at,status,payment_status,payment_method,customer_first_name,customer_last_name,customer_email,customer_phone,customer_address,church_name,section_name,delivery_address,total_amount_cents,stripe_checkout_session_id,admin_notes,order_items(product_name_snapshot,product_emoji_snapshot,qty,line_total_cents)&order=created_at.desc&limit=500'
      );
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (type === 'donations') {
      const data = await supaFetch('donations',
        '?select=id,created_at,donor_first_name,donor_last_name,donor_email,donor_phone,church_name,section_name,message,amount_cents,payment_status,stripe_checkout_session_id&order=created_at.desc&limit=500'
      );
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'type invalide' }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
