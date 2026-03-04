from py_order_utils.builders import OrderBuilder as UtilsOrderBuilder
from py_order_utils.signer import Signer as UtilsSigner
from py_order_utils.model import (
    EOA,
    OrderData,
    SignedOrder,
    BUY as UtilsBuy,
    SELL as UtilsSell,
)

from .helpers import (
    to_token_decimals,
    round_down,
    round_normal,
    decimal_places,
    round_up,
)
from .constants import BUY, SELL
from ..config import get_contract_config
from ..signer import Signer
from ..clob_types import (
    OrderArgs,
    CreateOrderOptions,
    TickSize,
    RoundConfig,
    MarketOrderArgs,
    OrderSummary,
    OrderType,
)

ROUNDING_CONFIG: dict[TickSize, RoundConfig] = {
    "0.1": RoundConfig(price=1, size=2, amount=3),
    "0.01": RoundConfig(price=2, size=2, amount=4),
    "0.001": RoundConfig(price=3, size=2, amount=5),
    "0.0001": RoundConfig(price=4, size=2, amount=6),
}


class OrderBuilder:
    def __init__(self, signer: Signer, sig_type=None, funder=None):
        self.signer = signer

        # Signature type used sign orders, defaults to EOA type
        self.sig_type = sig_type if sig_type is not None else EOA

        # Address which holds funds to be used.
        # Used for Polymarket proxy wallets and other smart contract wallets
        # Defaults to the address of the signer
        self.funder = funder if funder is not None else self.signer.address()

    def get_order_amounts(
        self, side: str, size: float, price: float, round_config: RoundConfig
    ):
        raw_price = round_normal(price, round_config.price)

        if side == BUY:
            raw_taker_amt = round_down(size, round_config.size)

            raw_maker_amt = raw_taker_amt * raw_price
            if decimal_places(raw_maker_amt) > round_config.amount:
                raw_maker_amt = round_up(raw_maker_amt, round_config.amount + 4)
                if decimal_places(raw_maker_amt) > round_config.amount:
                    raw_maker_amt = round_down(raw_maker_amt, round_config.amount)

            maker_amount = to_token_decimals(raw_maker_amt)
            taker_amount = to_token_decimals(raw_taker_amt)

            return UtilsBuy, maker_amount, taker_amount
        elif side == SELL:
            raw_maker_amt = round_down(size, round_config.size)

            raw_taker_amt = raw_maker_amt * raw_price
            if decimal_places(raw_taker_amt) > round_config.amount:
                raw_taker_amt = round_up(raw_taker_amt, round_config.amount + 4)
                if decimal_places(raw_taker_amt) > round_config.amount:
                    raw_taker_amt = round_down(raw_taker_amt, round_config.amount)

            maker_amount = to_token_decimals(raw_maker_amt)
            taker_amount = to_token_decimals(raw_taker_amt)

            return UtilsSell, maker_amount, taker_amount
        else:
            raise ValueError(f"order_args.side must be '{BUY}' or '{SELL}'")

    def get_market_order_amounts(
        self, side: str, amount: float, price: float, round_config: RoundConfig
    ):
        raw_price = round_normal(price, round_config.price)

        if side == BUY:
            raw_maker_amt = round_down(amount, round_config.size)
            raw_taker_amt = raw_maker_amt / raw_price
            if decimal_places(raw_taker_amt) > round_config.amount:
                raw_taker_amt = round_up(raw_taker_amt, round_config.amount + 4)
                if decimal_places(raw_taker_amt) > round_config.amount:
                    raw_taker_amt = round_down(raw_taker_amt, round_config.amount)

            maker_amount = to_token_decimals(raw_maker_amt)
            taker_amount = to_token_decimals(raw_taker_amt)

            return UtilsBuy, maker_amount, taker_amount

        elif side == SELL:
            raw_maker_amt = round_down(amount, round_config.size)

            raw_taker_amt = raw_maker_amt * raw_price
            if decimal_places(raw_taker_amt) > round_config.amount:
                raw_taker_amt = round_up(raw_taker_amt, round_config.amount + 4)
                if decimal_places(raw_taker_amt) > round_config.amount:
                    raw_taker_amt = round_down(raw_taker_amt, round_config.amount)

            maker_amount = to_token_decimals(raw_maker_amt)
            taker_amount = to_token_decimals(raw_taker_amt)

            return UtilsSell, maker_amount, taker_amount
        else:
            raise ValueError(f"order_args.side must be '{BUY}' or '{SELL}'")

    def create_order(
        self, order_args: OrderArgs, options: CreateOrderOptions
    ) -> SignedOrder:
        """
        Creates and signs an order
        """
        side, maker_amount, taker_amount = self.get_order_amounts(
            order_args.side,
            order_args.size,
            order_args.price,
            ROUNDING_CONFIG[options.tick_size],
        )

        data = OrderData(
            maker=self.funder,
            taker=order_args.taker,
            tokenId=order_args.token_id,
            makerAmount=str(maker_amount),
            takerAmount=str(taker_amount),
            side=side,
            feeRateBps=str(order_args.fee_rate_bps),
            nonce=str(order_args.nonce),
            signer=self.signer.address(),
            expiration=str(order_args.expiration),
            signatureType=self.sig_type,
        )

        contract_config = get_contract_config(
            self.signer.get_chain_id(), options.neg_risk
        )

        order_builder = UtilsOrderBuilder(
            contract_config.exchange,
            self.signer.get_chain_id(),
            UtilsSigner(key=self.signer.private_key),
        )

        return order_builder.build_signed_order(data)

    def create_market_order(
        self, order_args: MarketOrderArgs, options: CreateOrderOptions
    ) -> SignedOrder:
        """
        Creates and signs a market order
        """
        side, maker_amount, taker_amount = self.get_market_order_amounts(
            order_args.side,
            order_args.amount,
            order_args.price,
            ROUNDING_CONFIG[options.tick_size],
        )

        data = OrderData(
            maker=self.funder,
            taker=order_args.taker,
            tokenId=order_args.token_id,
            makerAmount=str(maker_amount),
            takerAmount=str(taker_amount),
            side=side,
            feeRateBps=str(order_args.fee_rate_bps),
            nonce=str(order_args.nonce),
            signer=self.signer.address(),
            expiration="0",
            signatureType=self.sig_type,
        )

        contract_config = get_contract_config(
            self.signer.get_chain_id(), options.neg_risk
        )

        order_builder = UtilsOrderBuilder(
            contract_config.exchange,
            self.signer.get_chain_id(),
            UtilsSigner(key=self.signer.private_key),
        )

        return order_builder.build_signed_order(data)

    def calculate_buy_market_price(
        self,
        positions: list[OrderSummary],
        amount_to_match: float,
        order_type: OrderType,
    ) -> float:
        if not positions:
            raise Exception("no match")

        sum = 0
        for p in reversed(positions):
            sum += float(p.size) * float(p.price)
            if sum >= amount_to_match:
                return float(p.price)

        if order_type == OrderType.FOK:
            raise Exception("no match")

        return float(positions[0].price)

    def calculate_sell_market_price(
        self,
        positions: list[OrderSummary],
        amount_to_match: float,
        order_type: OrderType,
    ) -> float:
        if not positions:
            raise Exception("no match")

        sum = 0
        for p in reversed(positions):
            sum += float(p.size)
            if sum >= amount_to_match:
                return float(p.price)

        if order_type == OrderType.FOK:
            raise Exception("no match")

        return float(positions[0].price)
