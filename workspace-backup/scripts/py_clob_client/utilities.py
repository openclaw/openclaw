import hashlib
import json

from .clob_types import OrderBookSummary, OrderSummary, TickSize


def parse_raw_orderbook_summary(raw_obs: any) -> OrderBookSummary:
    bids = []
    for bid in raw_obs["bids"]:
        bids.append(OrderSummary(size=bid["size"], price=bid["price"]))

    asks = []
    for ask in raw_obs["asks"]:
        asks.append(OrderSummary(size=ask["size"], price=ask["price"]))

    orderbookSummary = OrderBookSummary(
        market=raw_obs["market"],
        asset_id=raw_obs["asset_id"],
        timestamp=raw_obs["timestamp"],
        last_trade_price=raw_obs["last_trade_price"],
        min_order_size=raw_obs["min_order_size"],
        neg_risk=raw_obs["neg_risk"],
        tick_size=raw_obs["tick_size"],
        bids=bids,
        asks=asks,
        hash=raw_obs["hash"],
    )

    return orderbookSummary


def generate_orderbook_summary_hash(orderbook: OrderBookSummary) -> str:
    """
    Server-compatible orderbook hash.

    The server computes SHA1 over a compact JSON payload with a specific key order,
    and with the "hash" field set to an empty string while hashing.
    """

    # Go server-side payload field order (struct order):
    # market, asset_id, timestamp, hash, bids, asks, min_order_size, tick_size, neg_risk, last_trade_price
    payload = {
        "market": orderbook.market,
        "asset_id": orderbook.asset_id,
        "timestamp": orderbook.timestamp,
        "hash": "",
        "bids": [{"price": o.price, "size": o.size} for o in (orderbook.bids or [])],
        "asks": [{"price": o.price, "size": o.size} for o in (orderbook.asks or [])],
        "min_order_size": orderbook.min_order_size,
        "tick_size": orderbook.tick_size,
        "neg_risk": orderbook.neg_risk,
        "last_trade_price": orderbook.last_trade_price,
    }

    serialized = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    h = hashlib.sha1(serialized.encode("utf-8")).hexdigest()
    orderbook.hash = h
    return h


def order_to_json(order, owner, orderType, post_only: bool = False) -> dict:
    return {"order": order.dict(), "owner": owner, "orderType": orderType, "postOnly": post_only}


def is_tick_size_smaller(a: TickSize, b: TickSize) -> bool:
    return float(a) < float(b)


def price_valid(price: float, tick_size: TickSize) -> bool:
    return price >= float(tick_size) and price <= 1 - float(tick_size)
