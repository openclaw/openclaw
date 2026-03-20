// Stripe checkout session creator
// Deploy as Vercel serverless function at /api/checkout
//
// Environment variables required:
//   STRIPE_SECRET_KEY - your Stripe secret key (sk_live_...)
//
// Price IDs - create these in Stripe Dashboard > Products > Prices
//   price_starter  -> $27 one-time
//   price_pro      -> $47 one-time
//   price_complete -> $97 one-time

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Map internal price names to Stripe Price IDs
// TODO: Replace with real Stripe Price IDs after creating products in dashboard
const PRICE_MAP = {
  price_starter: process.env.STRIPE_PRICE_STARTER || "price_PLACEHOLDER_STARTER",
  price_pro: process.env.STRIPE_PRICE_PRO || "price_PLACEHOLDER_PRO",
  price_complete: process.env.STRIPE_PRICE_COMPLETE || "price_PLACEHOLDER_COMPLETE",
};

module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { priceId } = req.body;

    if (!priceId || !PRICE_MAP[priceId]) {
      return res.status(400).json({ error: "Invalid price tier" });
    }

    const stripePriceId = PRICE_MAP[priceId];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
        },
      ],
      success_url: `${req.headers.origin || "https://your-domain.com"}/?success=true`,
      cancel_url: `${req.headers.origin || "https://your-domain.com"}/?canceled=true`,
      // Collect email for digital delivery
      customer_creation: "always",
      // Metadata for fulfillment webhook
      metadata: {
        tier: priceId,
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
};
